// 串口调试工具（SSCOM 复刻版）Rust + Tauri 2 后端
// 负责串口 / TCP 客户端 / TCP 服务端 / UDP 的打开、收发与关闭；
// 收到的数据以 base64 通过事件推送给前端渲染。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use chrono::Local;
use serde::{Deserialize, Serialize};
use serialport::{DataBits, Parity, SerialPort, StopBits};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream, ToSocketAddrs, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, State};

// ---------------------------------------------------------------- 会话管理

struct Session {
    kind: String, // serial / tcp_client / tcp_server / udp
    stop: Arc<AtomicBool>,
    serial: Option<Box<dyn SerialPort + Send>>,
    client: Option<TcpStream>,
    server_writers: Option<Arc<Mutex<Vec<(SocketAddr, TcpStream)>>>>,
    udp: Option<Arc<UdpSocket>>,
    udp_remote: Option<SocketAddr>,
}

impl Session {
    fn stop(&self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(v) = self.server_writers.as_ref() {
            v.lock().unwrap().clear();
        }
    }
}

#[derive(Default)]
struct CommState(Mutex<Option<Session>>);

// ---------------------------------------------------------------- 事件载荷

#[derive(Clone, Serialize)]
struct DataEvent {
    time: String,
    data: String, // base64
}

#[derive(Clone, Serialize)]
struct InfoEvent {
    time: String,
    level: String, // info / error
    text: String,
}

fn now_stamp() -> String {
    Local::now().format("%H:%M:%S%.3f").to_string()
}

fn emit_info(app: &AppHandle, text: String, level: &str) {
    let _ = app.emit("comm-info", InfoEvent { time: now_stamp(), level: level.into(), text });
}

fn is_block_err(e: &std::io::Error) -> bool {
    matches!(
        e.kind(),
        std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
    )
}

// ---------------------------------------------------------------- 打开各类连接

fn open_serial(app: AppHandle, params: &OpenParams) -> Result<Session, String> {
    let name = params.port.clone().ok_or("未指定串口号")?;
    let baud = params.baud.unwrap_or(115200);
    let parity = match params.parity.as_deref().unwrap_or("none") {
        "odd" => Parity::Odd,
        "even" => Parity::Even,
        _ => Parity::None,
    };
    let data_bits = match params.data_bits.unwrap_or(8) {
        5 => DataBits::Five,
        6 => DataBits::Six,
        7 => DataBits::Seven,
        _ => DataBits::Eight,
    };
    let stop_bits = match params.stop_bits.unwrap_or(1.0) as u32 {
        2 => StopBits::Two,
        _ => StopBits::One, // 1.5 也归入 One（Windows 常见做法）
    };
    let port = serialport::new(&name, baud)
        .data_bits(data_bits)
        .parity(parity)
        .stop_bits(stop_bits)
        .timeout(Duration::from_millis(50))
        .open()
        .map_err(|e| format!("打开 {name} 失败: {e}"))?;
    let reader = port.try_clone().map_err(|e| format!("克隆串口失败: {e}"))?;

    let mut session = Session {
        kind: "serial".into(),
        stop: Arc::new(AtomicBool::new(false)),
        serial: Some(port),
        client: None,
        server_writers: None,
        udp: None,
        udp_remote: None,
    };
    let stop = session.stop.clone();
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut buf = [0u8; 4096];
        while !stop.load(Ordering::Relaxed) {
            match reader.read(&mut buf) {
                Ok(0) => std::thread::sleep(Duration::from_millis(5)),
                Ok(n) => {
                    let ev = DataEvent { time: now_stamp(), data: B64.encode(&buf[..n]) };
                    if app.emit("comm-data", ev).is_err() {
                        break;
                    }
                }
                Err(e) if is_block_err(&e) => continue,
                Err(e) => {
                    if !stop.load(Ordering::Relaxed) {
                        emit_info(&app, format!("串口读错误，已断开: {e}"), "error");
                    }
                    break;
                }
            }
        }
    });
    Ok(session)
}

fn open_tcp_client(app: AppHandle, params: &OpenParams) -> Result<Session, String> {
    let host = params.remote_host.clone().unwrap_or_default();
    let port = params.remote_port.ok_or("未指定远程端口")?;
    let addrs: Vec<_> = (host.as_str(), port)
        .to_socket_addrs()
        .map_err(|e| format!("域名解析失败: {e}"))?
        .collect();
    let mut stream = None;
    let mut last_err = String::from("无可用的目标地址");
    for a in &addrs {
        match TcpStream::connect_timeout(a, Duration::from_secs(5)) {
            Ok(s) => {
                stream = Some(s);
                break;
            }
            Err(e) => last_err = format!("连接 {a} 失败: {e}"),
        }
    }
    let stream = stream.ok_or(last_err)?;
    let reader = stream.try_clone().map_err(|e| e.to_string())?;
    let peer = stream.peer_addr().map(|a| a.to_string()).unwrap_or_default();

    let mut session = Session {
        kind: "tcp_client".into(),
        stop: Arc::new(AtomicBool::new(false)),
        serial: None,
        client: Some(stream),
        server_writers: None,
        udp: None,
        udp_remote: None,
    };
    let stop = session.stop.clone();
    std::thread::spawn(move || {
        emit_info(&app, format!("已连接到 {peer}"), "info");
        let mut reader = reader;
        let mut buf = [0u8; 4096];
        while !stop.load(Ordering::Relaxed) {
            match reader.read(&mut buf) {
                Ok(0) => {
                    emit_info(&app, format!("服务器 {peer} 已断开连接"), "error");
                    break;
                }
                Ok(n) => {
                    let ev = DataEvent { time: now_stamp(), data: B64.encode(&buf[..n]) };
                    if app.emit("comm-data", ev).is_err() {
                        break;
                    }
                }
                Err(e) if is_block_err(&e) => continue,
                Err(_) => {
                    if !stop.load(Ordering::Relaxed) {
                        emit_info(&app, format!("与 {peer} 的连接已断开"), "error");
                    }
                    break;
                }
            }
        }
    });
    Ok(session)
}

fn open_tcp_server(app: AppHandle, params: &OpenParams) -> Result<Session, String> {
    let port = params.local_port.ok_or("未指定监听端口")?;
    let host = params.local_host.clone().unwrap_or_else(|| "0.0.0.0".into());
    let listener = TcpListener::bind((host.as_str(), port)).map_err(|e| format!("监听 {host}:{port} 失败: {e}"))?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;

    let mut session = Session {
        kind: "tcp_server".into(),
        stop: Arc::new(AtomicBool::new(false)),
        serial: None,
        client: None,
        server_writers: Some(Arc::new(Mutex::new(Vec::new()))),
        udp: None,
        udp_remote: None,
    };
    let stop = session.stop.clone();
    let writers = session.server_writers.clone().unwrap();
    std::thread::spawn(move || {
        emit_info(&app, format!("TCP服务端正在监听 {host}:{port}，等待客户端连接…"), "info");
        loop {
            if stop.load(Ordering::Relaxed) {
                break;
            }
            match listener.accept() {
                Ok((stream, addr)) => {
                    let _ = stream.set_nodelay(true);
                    emit_info(&app, format!("客户端 {addr} 已连接"), "info");
                    let reader = stream.try_clone().ok();
                    writers.lock().unwrap().push((addr, stream));
                    let app = app.clone();
                    let stop = stop.clone();
                    let writers = writers.clone();
                    std::thread::spawn(move || {
                        let Some(mut reader) = reader else { return };
                        let mut buf = [0u8; 4096];
                        while !stop.load(Ordering::Relaxed) {
                            match reader.read(&mut buf) {
                                Ok(0) => break,
                                Ok(n) => {
                                    let ev = DataEvent { time: now_stamp(), data: B64.encode(&buf[..n]) };
                                    if app.emit("comm-data", ev).is_err() {
                                        break;
                                    }
                                }
                                Err(e) if is_block_err(&e) => continue,
                                Err(_) => break,
                            }
                        }
                        writers.lock().unwrap().retain(|(a, _)| *a != addr);
                        emit_info(&app, format!("客户端 {addr} 已断开"), "error");
                    });
                }
                Err(_) => std::thread::sleep(Duration::from_millis(100)),
            }
        }
        emit_info(&app, format!("TCP服务端已停止监听 {port}"), "info");
    });
    Ok(session)
}

fn open_udp(app: AppHandle, params: &OpenParams) -> Result<Session, String> {
    let port = params.local_port.ok_or("未指定绑定端口")?;
    // 绑定具体网卡 IP 时，Windows 强主机模型会强制 UDP 包从该网卡发出（源地址即该 IP）；
    // 0.0.0.0 则由路由表自动选择出口，并接收所有网卡的包
    let host = params.local_host.clone().unwrap_or_else(|| "0.0.0.0".into());
    let socket = UdpSocket::bind((host.as_str(), port)).map_err(|e| format!("绑定 UDP {host}:{port} 失败: {e}"))?;
    socket.set_read_timeout(Some(Duration::from_millis(200))).ok();

    let remote = match (&params.remote_host, params.remote_port) {
        (Some(h), Some(rp)) if !h.trim().is_empty() => Some(
            (h.trim(), rp)
                .to_socket_addrs()
                .map_err(|e| format!("远程地址解析失败: {e}"))?
                .next()
                .ok_or("远程地址解析失败")?,
        ),
        _ => None,
    };

    let mut session = Session {
        kind: "udp".into(),
        stop: Arc::new(AtomicBool::new(false)),
        serial: None,
        client: None,
        server_writers: None,
        udp: Some(Arc::new(socket)),
        udp_remote: remote,
    };
    let stop = session.stop.clone();
    let sock = session.udp.clone().unwrap();
    std::thread::spawn(move || {
        emit_info(&app, format!("UDP 已绑定 {host}:{port}"), "info");
        let mut buf = [0u8; 4096];
        while !stop.load(Ordering::Relaxed) {
            match sock.recv_from(&mut buf) {
                Ok((n, from)) => {
                    let _ = app.emit("comm-peer", from.to_string());
                    let ev = DataEvent { time: now_stamp(), data: B64.encode(&buf[..n]) };
                    if app.emit("comm-data", ev).is_err() {
                        break;
                    }
                }
                Err(e) if is_block_err(&e) => continue,
                Err(_) if stop.load(Ordering::Relaxed) => break,
                Err(_) => continue,
            }
        }
    });
    Ok(session)
}

// ---------------------------------------------------------------- 命令

#[derive(Deserialize)]
pub struct OpenParams {
    kind: String,
    port: Option<String>,
    baud: Option<u32>,
    parity: Option<String>,
    data_bits: Option<u8>,
    stop_bits: Option<f32>,
    local_port: Option<u16>,
    local_host: Option<String>,
    remote_host: Option<String>,
    remote_port: Option<u16>,
}

#[tauri::command]
fn open(app: AppHandle, state: State<CommState>, params: OpenParams) -> Result<String, String> {
    // 先停掉并关闭旧连接
    {
        let mut guard = state.0.lock().unwrap();
        if let Some(cur) = guard.as_ref() {
            cur.stop();
        }
        *guard = None;
    }
    let session = match params.kind.as_str() {
        "serial" => open_serial(app.clone(), &params)?,
        "tcp_client" => open_tcp_client(app.clone(), &params)?,
        "tcp_server" => open_tcp_server(app.clone(), &params)?,
        "udp" => open_udp(app.clone(), &params)?,
        other => return Err(format!("未知连接类型: {other}")),
    };
    let desc = desc_of(&params);
    *state.0.lock().unwrap() = Some(session);
    Ok(desc)
}

fn desc_of(params: &OpenParams) -> String {
    match params.kind.as_str() {
        "serial" => format!("串口 {} @ {}", params.port.as_deref().unwrap_or(""), params.baud.unwrap_or(115200)),
        "tcp_client" => format!("TCP客户端 {} -> {}:{}", "[本机]", params.remote_host.as_deref().unwrap_or(""), params.remote_port.unwrap_or(0)),
        "tcp_server" => format!("TCP服务端 {}:{}", params.local_host.as_deref().unwrap_or("0.0.0.0"), params.local_port.unwrap_or(0)),
        "udp" => format!("UDP {}:{} -> {}:{}", params.local_host.as_deref().unwrap_or("0.0.0.0"), params.local_port.unwrap_or(0), params.remote_host.as_deref().unwrap_or("-"), params.remote_port.unwrap_or(0)),
        _ => String::new(),
    }
}

#[tauri::command]
fn close(state: State<CommState>) {
    let mut guard = state.0.lock().unwrap();
    if let Some(s) = guard.as_ref() {
        s.stop();
    }
    *guard = None;
}

#[tauri::command]
fn send(state: State<CommState>, data: Vec<u8>) -> Result<usize, String> {
    let mut guard = state.0.lock().unwrap();
    let session = guard.as_mut().ok_or("尚未打开连接")?;
    let n = data.len();
    match session.kind.as_str() {
        "serial" => {
            let p = session.serial.as_mut().ok_or("串口未打开")?;
            p.write_all(&data).map_err(|e| format!("串口发送失败: {e}"))?;
        }
        "tcp_client" => {
            let s = session.client.as_mut().ok_or("连接已断开")?;
            s.write_all(&data).map_err(|e| format!("TCP发送失败: {e}"))?;
        }
        "tcp_server" => {
            let vec = session.server_writers.as_ref().ok_or("服务端未监听")?;
            let mut vec = vec.lock().unwrap();
            if vec.is_empty() {
                return Err("当前没有客户端连接".into());
            }
            vec.retain_mut(|(_, s)| s.write_all(&data).is_ok());
        }
        "udp" => {
            let remote = session.udp_remote.ok_or("未设置远程地址")?;
            let s = session.udp.as_ref().ok_or("UDP未绑定")?;
            s.send_to(&data, remote).map_err(|e| format!("UDP发送失败: {e}"))?;
        }
        _ => return Err("未知连接类型".into()),
    }
    Ok(n)
}

#[tauri::command]
fn list_ports() -> Vec<String> {
    serialport::available_ports()
        .unwrap_or_default()
        .into_iter()
        .map(|p| p.port_name)
        .filter(|n| n.starts_with("COM"))
        .collect()
}

#[tauri::command]
fn local_ip() -> String {
    if let Ok(s) = UdpSocket::bind("0.0.0.0:0") {
        if s.connect("8.8.8.8:53").is_ok() {
            if let Ok(addr) = s.local_addr() {
                return addr.ip().to_string();
            }
        }
    }
    "127.0.0.1".into()
}

/// 枚举所有网卡的 IPv4 地址（多网卡/同网卡多 IP 均可列出），供 TCP服务端/UDP 选择绑定
#[tauri::command]
fn local_ips() -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    if let Ok(ifaces) = if_addrs::get_if_addrs() {
        for iface in ifaces {
            if let if_addrs::IfAddr::V4(v4) = iface.addr {
                let ip = v4.ip.to_string();
                if ip != "127.0.0.1" && !out.contains(&ip) {
                    out.push(ip);
                }
            }
        }
    }
    out
}

/// 弹出系统"另存为"对话框让用户选择保存位置，把接收区内容写入文件。
/// 返回保存路径；用户取消时返回空字符串。
#[tauri::command]
fn save_recv_file(
    content: String,
    default_name: Option<String>,
    title: Option<String>,
) -> Result<String, String> {
    let default_name = default_name
        .unwrap_or_else(|| format!("serial_tool_{}.txt", chrono::Local::now().format("%Y%m%d_%H%M%S")));
    let path = rfd::FileDialog::new()
        .set_title(&title.unwrap_or_else(|| "保存接收数据".into()))
        .set_file_name(&default_name)
        .add_filter("日志文件", &["log", "txt"])
        .add_filter("所有文件", &["*"])
        .save_file();
    let Some(path) = path else {
        return Ok(String::new()); // 用户取消
    };
    std::fs::write(&path, content.as_bytes()).map_err(|e| format!("写入文件失败: {e}"))?;
    Ok(path.display().to_string())
}

/// 应用版本号（单一来源：Cargo.toml 的 package.version）
#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").into()
}

// ---------------------------------------------------------------- WebView2Loader.dll 自动迁移

/// 若 exe 同目录存在 WebView2Loader.dll，将其复制到 C:\Windows\System32，
/// 成功后清理本地文件：被本进程占用（内存映射中）无法直接删除时，改名 .old
/// 并启动一个隐藏进程，等本进程退出后自动删除——一次启动完成全部迁移。
/// 无管理员权限时复制失败，本地 dll 保留、程序照常运行。
fn relocate_webview2_loader() {
    let sys = Path::new(r"C:\Windows\System32\WebView2Loader.dll");
    let Some(dir) = std::env::current_exe().ok().and_then(|e| e.parent().map(std::path::Path::to_path_buf)) else {
        return;
    };
    let local: PathBuf = dir.join("WebView2Loader.dll");
    let bak: PathBuf = dir.join("WebView2Loader.dll.old");
    let local_meta = std::fs::metadata(&local).ok();
    let sys_meta = std::fs::metadata(sys).ok();

    match (local_meta, sys_meta) {
        // 本地没有 dll：上次已迁移过，直接清理 .old 残留（此时未被占用，可删）
        (None, Some(_)) => {
            let _ = std::fs::remove_file(&bak);
        }
        // 本地与系统目录内容一致：已迁移过，清理本地残留
        (Some(lm), Some(sm)) if lm.len() == sm.len() => {
            cleanup_local_dll(&dir, &local, &bak);
        }
        // 需要迁移：复制到 System32，成功后才清理本地
        (Some(lm), sm) if sm.is_none() || sm.as_ref().unwrap().len() != lm.len() => {
            if std::fs::copy(&local, sys).is_ok() {
                cleanup_local_dll(&dir, &local, &bak);
            }
        }
        _ => {}
    }
}

/// 删除本地 dll；因被本进程映射而失败时改名 .old，并启动延迟删除进程
fn cleanup_local_dll(dir: &Path, local: &Path, bak: &Path) {
    if std::fs::remove_file(local).is_ok() {
        return;
    }
    let _ = std::fs::remove_file(bak);
    if std::fs::rename(local, bak).is_ok() {
        spawn_delayed_delete(bak);
    }
}

/// 启动隐藏的 PowerShell 进程：等待当前进程退出后删除目标文件
fn spawn_delayed_delete(target: &Path) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let pid = std::process::id();
    let script = format!(
        "$p=Get-Process -Id {pid} -ErrorAction SilentlyContinue; \
         while($p){{ Start-Sleep -Milliseconds 500; \
           $p=Get-Process -Id {pid} -ErrorAction SilentlyContinue }}; \
         Remove-Item -Force -LiteralPath '{}' -ErrorAction SilentlyContinue",
        target.display()
    );
    let _ = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", &script])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn();
}

fn main() {
    relocate_webview2_loader();
    tauri::Builder::default()
        .manage(CommState::default())
        .invoke_handler(tauri::generate_handler![open, close, send, list_ports, local_ip, local_ips, save_recv_file, app_version])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
