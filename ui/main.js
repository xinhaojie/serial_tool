// 串口调试工具前端逻辑
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// 窗口尺寸自适应：若默认尺寸超过屏幕可用区域（高 DPI 缩放场景），自动缩小并居中
try {
  const availW = screen.availWidth;
  const availH = screen.availHeight;
  if (window.innerWidth > availW || window.innerHeight > availH) {
    const w = Math.max(760, Math.min(1000, Math.floor(availW * 0.92)));
    const h = Math.max(520, Math.min(680, Math.floor(availH * 0.9)));
    const win = window.__TAURI__.window.getCurrentWindow();
    win.setSize(new window.__TAURI__.dpi.LogicalSize(w, h));
    win.center();
  }
} catch (e) { console.error("窗口自适应失败", e); }

// ---------------------------------------------------------------- 元素引用
const $ = (id) => document.getElementById(id);
const recvArea = $("recv-area");
const sendInput = $("send-input");
const selKind = $("sel-kind");
const btnOpen = $("btn-open");
const connStatus = $("conn-status");
const udpPeer = $("udp-peer");

// ---------------------------------------------------------------- 状态
let opened = false;
let rxCount = 0;
let txCount = 0;
let selectedRow = -1;
let loopRunning = false;
let periodicTimer = null;

const BAUDS = [300, 600, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600, 1500000];

// ---------------------------------------------------------------- 工具
function b64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" ");
}

function bytesToText(bytes) {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes).replace(/\r/g, "");
}

function parseHexSend(str) {
  const cleaned = str.replace(/[\s,]/g, "");
  if (cleaned.length % 2 !== 0) throw new Error("HEX 字符数为奇数");
  const out = [];
  for (let i = 0; i < cleaned.length; i += 2) {
    const v = parseInt(cleaned.substr(i, 2), 16);
    if (Number.isNaN(v)) throw new Error(`第 ${i + 1} 处存在非法 HEX 字符`);
    out.push(v);
  }
  return out;
}

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function appendLine(tag, time, text) {
  if ($("chk-stop-display").checked && tag !== "err") return;
  const max = 5000;
  if (recvArea.childElementCount > max) recvArea.removeChild(recvArea.firstChild);
  const div = document.createElement("span");
  div.className = `line tag-${tag}`;
  div.textContent = `${time} [${tagLabel(tag)}] ${text}\n`;
  recvArea.appendChild(div);
  recvArea.scrollTop = recvArea.scrollHeight;
}

function tagLabel(tag) {
  return { rx: "接收", tx: "发送", info: "系统", err: "错误" }[tag] || tag;
}

function setStatus(text, cls) {
  connStatus.textContent = `● ${text}`;
  connStatus.className = `status ${cls}`;
}

function updateCounters() {
  $("rx-count").textContent = `接收: ${rxCount} 字节`;
  $("tx-count").textContent = `发送: ${txCount} 字节`;
}

// ---------------------------------------------------------------- 后端事件
listen("comm-data", (ev) => {
  const { time, data } = ev.payload;
  const bytes = b64ToBytes(data);
  rxCount += bytes.length;
  updateCounters();
  const hex = $("chk-hex-display").checked;
  appendLine("rx", time, hex ? bytesToHex(bytes) : bytesToText(bytes));
});

listen("comm-info", (ev) => {
  const { time, level, text } = ev.payload;
  appendLine(level === "error" ? "err" : "info", time, text);
  if (level === "error") setStatus(text, "err");
});

listen("comm-peer", (ev) => {
  udpPeer.hidden = false;
  udpPeer.textContent = `最近来源: ${ev.payload}`;
});

// ---------------------------------------------------------------- 连接
// 连接参数持久化（串口/TCP/UDP 全部参数 + 类型 + 定时间隔）
const CONN_PARAM_IDS = [
  "sel-kind", "sel-port", "sel-baud", "sel-parity", "sel-databits", "sel-stopbits",
  "in-remote-host", "in-remote-port",
  "sel-local-ip", "in-local-port",
  "sel-udp-local-ip", "in-udp-local-port", "in-udp-remote-host", "in-udp-remote-port",
  "periodic-ms",
];
// 异步填充的下拉框（串口列表/网卡列表）先记住，填充完成后再应用
const ASYNC_SELECTS = ["sel-port", "sel-local-ip", "sel-udp-local-ip"];
let savedConnParams = {};
try { savedConnParams = JSON.parse(localStorage.getItem("conn_params") || "{}") || {}; } catch { savedConnParams = {}; }

function applyConnParam(id) {
  const el = document.getElementById(id);
  const v = savedConnParams[id];
  if (!el || v === undefined || v === null || v === "") return false;
  if (el.tagName === "SELECT" && ![...el.options].some((o) => o.value === String(v))) return false;
  el.value = v;
  return true;
}

function saveConnParams() {
  const data = {};
  for (const id of CONN_PARAM_IDS) {
    const el = document.getElementById(id);
    if (el) data[id] = el.value;
  }
  localStorage.setItem("conn_params", JSON.stringify(data));
}

function fillPorts(ports) {
  const sel = $("sel-port");
  sel.innerHTML = "";
  for (const p of ports) {
    const opt = document.createElement("option");
    opt.value = p;
    opt.textContent = p;
    sel.appendChild(opt);
  }
  applyConnParam("sel-port");
}

async function refreshPorts() {
  try {
    fillPorts(await invoke("list_ports"));
  } catch (e) {
    console.error(e);
  }
}

$("btn-refresh-ports").onclick = refreshPorts;

function currentParams() {
  const kind = selKind.value;
  const params = { kind };
  if (kind === "serial") {
    params.port = $("sel-port").value;
    params.baud = parseInt($("sel-baud").value, 10);
    params.parity = $("sel-parity").value;
    params.data_bits = parseInt($("sel-databits").value, 10);
    params.stop_bits = parseFloat($("sel-stopbits").value);
  } else if (kind === "tcp_client") {
    params.remote_host = $("in-remote-host").value.trim();
    params.remote_port = parseInt($("in-remote-port").value, 10);
  } else if (kind === "tcp_server") {
    params.local_host = $("sel-local-ip").value || "0.0.0.0";
    params.local_port = parseInt($("in-local-port").value, 10);
  } else if (kind === "udp") {
    params.local_host = $("sel-udp-local-ip").value || "0.0.0.0";
    params.local_port = parseInt($("in-udp-local-port").value, 10);
    params.remote_host = $("in-udp-remote-host").value.trim();
    params.remote_port = parseInt($("in-udp-remote-port").value, 10);
  }
  return params;
}

function validateParams(p) {
  if (p.kind === "serial" && !p.port) return "未检测到可用串口，请点击「刷新端口」";
  if (p.kind === "tcp_client") {
    if (!p.remote_host) return "远程IP/域名不能为空";
    if (!(p.remote_port > 0 && p.remote_port < 65536)) return "远程端口非法";
  }
  if ((p.kind === "tcp_server" || p.kind === "udp") && !(p.local_port > 0 && p.local_port < 65536)) return "本机端口非法";
  if (p.kind === "udp" && p.remote_host && !(p.remote_port > 0 && p.remote_port < 65536)) return "远程端口非法";
  return null;
}

async function openConn() {
  const params = currentParams();
  const err = validateParams(params);
  if (err) return setStatus(err, "err");
  try {
    const desc = await invoke("open", { params });
    opened = true;
    const openText = params.kind === "serial" ? "打开串口" : "连接";
    btnOpen.textContent = params.kind === "serial" ? "关闭串口" : "断开";
    btnOpen.classList.add("open");
    setStatus(`已打开 ${desc}`, "on");
    appendLine("info", nowStr(), `已打开 ${desc}`);
  } catch (e) {
    setStatus(String(e), "err");
    appendLine("err", nowStr(), String(e));
  }
}

async function closeConn() {
  try {
    await invoke("close");
  } catch (e) { /* ignore */ }
  opened = false;
  stopLoop();
  btnOpen.textContent = selKind.value === "serial" ? "打开串口" : "连接";
  btnOpen.classList.remove("open");
  udpPeer.hidden = true;
  setStatus("已断开", "off");
  appendLine("info", nowStr(), "已断开连接");
}

function nowStr() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

btnOpen.onclick = () => (opened ? closeConn() : openConn());

const KIND_HINTS = {
  serial: "选择设备的 COM 口和波特率（常用 115200），点击「打开串口」即可收发数据",
  tcp_client: "填对方设备的 IP 和端口，点击「连接」，连接成功后即可收发数据",
  tcp_server: "选择监听IP（0.0.0.0=所有网卡）和端口，点击「连接」开始等待，客户端连上后会显示在接收区",
  udp: "填本机绑定端口和对方的 IP/端口，点击「连接」即可收发数据报",
};

function updateKindHint() {
  $("kind-hint").textContent = KIND_HINTS[selKind.value] || "";
}

selKind.onchange = () => {
  const kind = selKind.value;
  document.querySelectorAll(".kind-params").forEach((el) => (el.hidden = false));
  document.querySelector(".serial-params").hidden = kind !== "serial";
  document.querySelector(".tcpclient-params").hidden = kind !== "tcp_client";
  document.querySelector(".tcpserver-params").hidden = kind !== "tcp_server";
  document.querySelector(".udp-params").hidden = kind !== "udp";
  btnOpen.textContent = opened ? (kind === "serial" ? "关闭串口" : "断开") : kind === "serial" ? "打开串口" : "连接";
  updateKindHint();
};

// ---------------------------------------------------------------- 校验值计算
// 返回要附加在数据末尾的字节数组
function checksumBytes(kind, d) {
  switch (kind) {
    case "add8": { // 8位累加和
      let s = 0;
      for (const b of d) s = (s + b) & 0xff;
      return [s];
    }
    case "add16": { // 16位累加和，低字节在前
      let s = 0;
      for (const b of d) s = (s + b) & 0xffff;
      return [s & 0xff, (s >> 8) & 0xff];
    }
    case "crc8": { // CRC-8 poly=0x07 init=0x00
      let c = 0;
      for (const b of d) {
        c ^= b;
        for (let i = 0; i < 8; i++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
      }
      return [c & 0xff];
    }
    case "modbus16": { // Modbus RTU: poly=0xA001 init=0xFFFF，低字节在前
      let c = 0xffff;
      for (const b of d) {
        c ^= b;
        for (let i = 0; i < 8; i++) c = c & 1 ? (c >> 1) ^ 0xa001 : c >> 1;
      }
      return [c & 0xff, (c >> 8) & 0xff];
    }
    case "cdit16": { // CDIT-CRC16: CCITT poly=0x1021 init=0xFFFF，高字节在前
      let c = 0xffff;
      for (const b of d) {
        c ^= b << 8;
        for (let i = 0; i < 8; i++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
      }
      return [(c >> 8) & 0xff, c & 0xff];
    }
    case "crc32": { // CRC-32/IEEE poly=0xEDB88320，低字节在前
      let c = 0xffffffff;
      for (const b of d) {
        c ^= b;
        for (let i = 0; i < 8; i++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
      }
      c = (c ^ 0xffffffff) >>> 0;
      return [c & 0xff, (c >>> 8) & 0xff, (c >>> 16) & 0xff, (c >>> 24) & 0xff];
    }
    default:
      return [];
  }
}

// ---------------------------------------------------------------- 发送
async function doSendText(raw) {
  try {
    const hex = $("chk-hex-send").checked;
    const nl = $("chk-newline").checked;
    const payload = nl ? raw + ($("sel-newline").value === "crlf" ? "\r\n" : "\n") : raw;
    let data = hex ? parseHexSend(payload) : Array.from(new TextEncoder().encode(payload));
    // 附加校验值
    const csKind = $("sel-checksum").value;
    if (csKind !== "none" && data.length > 0) {
      data = data.concat(checksumBytes(csKind, data));
    }
    const n = await invoke("send", { data });
    txCount += n;
    updateCounters();
    const disp = $("chk-hex-display").checked
      ? bytesToHex(data)
      : new TextDecoder().decode(new Uint8Array(data)).replace(/\r/g, "");
    appendLine("tx", nowStr(), disp);
    return true;
  } catch (e) {
    appendLine("err", nowStr(), `发送失败: ${e}`);
    setStatus(`发送失败: ${e}`, "err");
    return false;
  }
}

$("btn-send").onclick = () => doSendText(sendInput.value);
$("btn-clear-send").onclick = () => (sendInput.value = "");
$("btn-clear-recv").onclick = () => (recvArea.innerHTML = "");

// ---------------------------------------------------------------- 主题（暗黑/白色）切换，「选项」菜单内，持久化
const chkDark = $("chk-dark");
function applyTheme(dark) {
  document.body.classList.toggle("dark", dark);
  chkDark.checked = dark;
}
chkDark.onchange = () => {
  applyTheme(chkDark.checked);
  localStorage.setItem("theme", chkDark.checked ? "dark" : "light");
};
applyTheme(localStorage.getItem("theme") === "dark");

const menuOptions = $("menu-options");
const optionsMenu = $("options-menu");
menuOptions.addEventListener("click", (e) => {
  // 点击菜单内部的复选框时不收起
  if (e.target.closest("#options-menu")) return;
  optionsMenu.hidden = !optionsMenu.hidden;
});
document.addEventListener("click", (e) => {
  if (!menuOptions.contains(e.target)) optionsMenu.hidden = true;
});

// ---------------------------------------------------------------- 帮助菜单（关于 / License）
const menuHelp = $("menu-help");
const helpMenu = $("help-menu");
menuHelp.addEventListener("click", (e) => {
  if (e.target.closest("#help-menu")) return;
  helpMenu.hidden = !helpMenu.hidden;
});
document.addEventListener("click", (e) => {
  if (!menuHelp.contains(e.target)) helpMenu.hidden = true;
});

// 通用弹窗
const modalMask = $("modal-mask");
const modalTitle = $("modal-title");
const modalBody = $("modal-body");
function showModal(title, html) {
  modalTitle.textContent = title;
  modalBody.innerHTML = html;
  modalMask.hidden = false;
}
$("modal-close").onclick = () => (modalMask.hidden = true);
modalMask.addEventListener("click", (e) => {
  if (e.target === modalMask) modalMask.hidden = true; // 点击遮罩关闭
});

const MIT_LICENSE = `MIT License

Copyright (c) 2026 心情 (xinhaojie@foxmail.com)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

$("menu-about").onclick = async () => {
  let ver = "?.?.?";
  try {
    ver = await invoke("app_version");
  } catch (e) { /* ignore */ }
  showModal("关于", `
    <p><b>串口调试工具</b>(作者:心情) v${ver}</p>
    <p>串口 / TCP客户端 / TCP服务端 / UDP 调试工具</p>
    <p style="margin-top:8px">作者：心情</p>
    <p>邮箱：xinhaojie@foxmail.com</p>
    <p style="margin-top:8px;color:var(--hint)">基于 Rust + Tauri 2 构建</p>
    <p style="color:var(--hint)">本软件以 MIT 协议开源（帮助 → License 查看全文）</p>
  `);
};
$("menu-license").onclick = () => {
  showModal("MIT License", `<pre>${MIT_LICENSE}</pre>`);
};



// 保存接收数据：弹出系统另存为对话框，把接收区当前显示内容写入用户选择的文件
$("btn-save-recv").onclick = async () => {
  const text = recvArea.innerText.replace(/\n+$/, "");
  if (!text.trim()) {
    setStatus("接收区为空，没有数据可保存", "err");
    return;
  }
  try {
    const path = await invoke("save_recv_file", { content: text });
    if (path) {
      setStatus(`已保存: ${path}`, "on");
      appendLine("info", nowStr(), `接收数据已保存到 ${path}`);
    }
  } catch (e) {
    setStatus(String(e), "err");
    appendLine("err", nowStr(), String(e));
  }
};

$("btn-zero-count").onclick = () => {
  rxCount = 0;
  txCount = 0;
  updateCounters();
};

// 定时发送
$("chk-periodic").onchange = () => {
  if (periodicTimer) {
    clearInterval(periodicTimer);
    periodicTimer = null;
  }
  if ($("chk-periodic").checked) {
    const ms = Math.max(10, parseInt($("periodic-ms").value, 10) || 1000);
    periodicTimer = setInterval(() => {
      if (opened && sendInput.value) doSendText(sendInput.value);
    }, ms);
  }
};

// ---------------------------------------------------------------- 多条字符串发送
let items = [];
try {
  items = JSON.parse(localStorage.getItem("multi_send_items") || "null") || [];
} catch { items = []; }
if (!Array.isArray(items) || items.length === 0) {
  items = [
    { content: "", ms: 1000, comment: "", checked: true },
    { content: "", ms: 1000, comment: "", checked: true },
  ];
}
// 旧数据迁移：无 checked 字段的行默认勾选
for (const it of items) if (it.checked === undefined) it.checked = true;

function saveItems() {
  localStorage.setItem("multi_send_items", JSON.stringify(items));
}

function renderMulti() {
  const list = $("multi-list");
  list.innerHTML = "";
  const locked = loopRunning; // 循环发送运行中：条目禁止编辑
  items.forEach((it, i) => {
    const row = document.createElement("div");
    row.className = "multi-row" + (selectedRow === i ? " selected" : "");

    const btnSend = document.createElement("button");
    btnSend.className = "btn small";
    btnSend.textContent = "发送";
    btnSend.disabled = locked;
    btnSend.onclick = (e) => {
      e.stopPropagation();
      selectRow(i);
      doSendText(it.content);
    };

    const dot = document.createElement("span");
    dot.className = "sel-dot";
    dot.textContent = selectedRow === i ? "●" : "○";
    dot.title = "选中";
    dot.onclick = (e) => {
      e.stopPropagation();
      selectRow(selectedRow === i ? -1 : i);
    };

    // 批量发送勾选框
    const chk = document.createElement("input");
    chk.type = "checkbox";
    chk.checked = it.checked !== false;
    chk.title = "勾选后参与批量/循环发送";
    chk.disabled = locked;
    chk.onclick = (e) => e.stopPropagation();
    chk.onchange = () => { it.checked = chk.checked; saveItems(); };

    const idx = document.createElement("span");
    idx.className = "idx";
    idx.textContent = String(i + 1).padStart(2, "0");

    const content = document.createElement("input");
    content.type = "text";
    content.className = "content";
    content.value = it.content;
    content.placeholder = "发送内容";
    content.disabled = locked;
    // 阻止冒泡：否则 row.onclick → renderMulti 重建 DOM 导致输入框瞬间失焦
    content.onclick = (e) => e.stopPropagation();
    content.oninput = () => { it.content = content.value; saveItems(); };

    const ms = document.createElement("input");
    ms.type = "text";
    ms.className = "ms";
    ms.value = it.ms;
    ms.title = "发送间隔(ms)";
    ms.disabled = locked;
    ms.onclick = (e) => e.stopPropagation();
    ms.oninput = () => { it.ms = parseInt(ms.value, 10) || 1000; saveItems(); };

    const comment = document.createElement("input");
    comment.type = "text";
    comment.className = "comment";
    comment.value = it.comment;
    comment.placeholder = "注释";
    comment.disabled = locked;
    comment.onclick = (e) => e.stopPropagation();
    comment.oninput = () => { it.comment = comment.value; saveItems(); };

    const del = document.createElement("button");
    del.className = "btn-del";
    del.textContent = "×";
    del.title = "删除";
    del.disabled = locked;
    del.onclick = (e) => {
      e.stopPropagation();
      items.splice(i, 1);
      if (selectedRow >= i) selectedRow--;
      saveItems();
      renderMulti();
    };

    row.append(btnSend, chk, dot, idx, content, ms, comment, del);
    row.onclick = () => selectRow(i);
    list.appendChild(row);
  });
}

function selectRow(i) {
  if (selectedRow === i) return; // 选中未变化时不重渲染，避免打断输入框焦点
  selectedRow = i;
  renderMulti();
}

$("btn-multi-add").onclick = () => {
  items.push({ content: "", ms: 1000, comment: "", checked: true });
  selectedRow = items.length - 1;
  saveItems();
  renderMulti();
};
$("btn-multi-del").onclick = () => {
  const kept = items.filter((it) => it.checked === false);
  const removed = items.length - kept.length;
  if (removed === 0) {
    appendLine("err", nowStr(), "删除选中：没有勾选任何条目（勾选框打勾的行会被删除）");
    return;
  }
  items = kept;
  selectedRow = -1;
  saveItems();
  renderMulti();
};
$("btn-multi-clear").onclick = () => {
  items = [];
  selectedRow = -1;
  stopLoop();
  saveItems();
  renderMulti();
};

$("btn-multi-load").onclick = () => $("multi-file").click();
$("multi-file").onchange = () => {
  const file = $("multi-file").files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const loaded = [];
    for (const raw of String(reader.result).split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const [content, ms, comment = ""] = line.split("\t");
      if (content) loaded.push({ content, ms: parseInt(ms, 10) || 1000, comment, checked: true });
    }
    if (loaded.length === 0) {
      appendLine("err", nowStr(), "加载失败：文件格式应为每行「内容<TAB>间隔ms<TAB>注释」");
    } else {
      items = loaded;
      selectedRow = -1;
      saveItems();
      renderMulti();
      appendLine("info", nowStr(), `已加载 ${items.length} 条发送记录`);
    }
  };
  reader.readAsText(file, "utf-8");
  $("multi-file").value = "";
};

$("btn-multi-save").onclick = async () => {
  const text = items.map((it) => `${it.content}\t${it.ms}\t${it.comment}`).join("\n");
  try {
    const path = await invoke("save_recv_file", {
      content: text,
      defaultName: "send_list.txt",
      title: "保存发送列表",
    });
    if (path) appendLine("info", nowStr(), `发送列表已保存：${path}`);
  } catch (e) {
    appendLine("err", nowStr(), `保存失败：${e}`);
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 循环发送：只发勾选且有内容的行，每条发送后的延时 = 行内间隔ms
// 运行期间锁定多条发送区的其他按钮和条目编辑，仅「停止循环」可用
const MULTI_TOOLBAR_BTNS = ["btn-multi-add", "btn-multi-del", "btn-multi-clear", "btn-multi-load", "btn-multi-save", "btn-multi-batch"];

function setMultiLock(locked) {
  for (const id of MULTI_TOOLBAR_BTNS) $(id).disabled = locked;
  renderMulti();
}

async function loopSend(targets) {
  let i = 0;
  while (loopRunning && targets.length > 0) {
    if (!opened) {
      appendLine("err", nowStr(), "连接已断开，循环发送停止");
      stopLoop();
      return;
    }
    if (i >= targets.length) i = 0;
    const ok = await doSendText(targets[i].content);
    if (!ok) {
      stopLoop();
      return;
    }
    const delay = targets[i].ms > 0 ? targets[i].ms : 1000;
    await sleep(Math.max(10, delay));
    i++;
  }
}

function stopLoop() {
  loopRunning = false;
  $("btn-multi-loop").textContent = "循环发送";
  setMultiLock(false);
}

$("btn-multi-loop").onclick = () => {
  if (loopRunning) {
    stopLoop();
    return;
  }
  const targets = items.filter((it) => it.checked !== false && it.content !== "");
  if (targets.length === 0) {
    appendLine("err", nowStr(), "循环发送：没有勾选任何有内容的条目");
    return;
  }
  if (!opened) {
    appendLine("err", nowStr(), "请先打开连接再启动循环发送");
    return;
  }
  loopRunning = true;
  $("btn-multi-loop").textContent = "停止循环";
  setMultiLock(true);
  appendLine("info", nowStr(), `循环发送已启动：${targets.length} 条，发送中其他条目已锁定`);
  loopSend(targets);
};

// 批量发送：按顺序发送所有勾选的行，行间隔 = 每条自己的间隔
let batchRunning = false;
async function batchSend() {
  const targets = items.filter((it) => it.checked !== false && it.content !== "");
  if (targets.length === 0) {
    appendLine("err", nowStr(), "批量发送：没有勾选任何有内容的条目");
    return;
  }
  if (!opened) {
    appendLine("err", nowStr(), "请先打开连接再批量发送");
    return;
  }
  batchRunning = true;
  $("btn-multi-batch").textContent = "发送中…";
  appendLine("info", nowStr(), `批量发送 ${targets.length} 条`);
  for (let i = 0; i < targets.length && batchRunning; i++) {
    const ok = await doSendText(targets[i].content);
    if (!ok) break;
    if (i < targets.length - 1) {
      const delay = targets[i].ms > 0 ? targets[i].ms : 1000;
      await sleep(Math.max(10, delay));
    }
  }
  batchRunning = false;
  $("btn-multi-batch").textContent = "批量发送";
}
$("btn-multi-batch").onclick = () => {
  if (!batchRunning) batchSend();
};

// ---------------------------------------------------------------- 初始化
for (const b of BAUDS) {
  const opt = document.createElement("option");
  opt.value = b;
  opt.textContent = b;
  if (b === 115200) opt.selected = true;
  $("sel-baud").appendChild(opt);
}
recvArea.innerHTML = `<span class="hint">（等待数据…… 串口/TCP/UDP 收到的数据会带时标显示在这里）</span>`;
// 恢复上次保存的连接参数（先恢复类型切换参数组显隐，再填其余字段）
if (applyConnParam("sel-kind")) selKind.onchange();
for (const id of CONN_PARAM_IDS) {
  if (id !== "sel-kind") applyConnParam(id);
}
$("connbar").addEventListener("change", saveConnParams);
refreshPorts();
invoke("local_ips").then((ips) => {
  for (const selId of ["sel-local-ip", "sel-udp-local-ip"]) {
    const sel = $(selId);
    sel.innerHTML = "";
    const add = (v, t) => {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = t ?? v;
      sel.appendChild(o);
    };
    add("0.0.0.0", "0.0.0.0（自动/所有网卡）");
    add("127.0.0.1", "127.0.0.1（仅本机）");
    for (const ip of ips) add(ip, `${ip}（本机网卡）`);
    applyConnParam(selId);
  }
}).catch(() => {});
renderMulti();
updateKindHint();

// ---------------------------------------------------------------- 多条发送面板：拖拽宽度 + 显示/隐藏
const rightPanel = $("right");
const resizer = document.createElement("div");
resizer.id = "right-resizer";
resizer.title = "拖动调整面板宽度";
rightPanel.appendChild(resizer);

const savedWidth = parseInt(localStorage.getItem("right_panel_width"), 10);
if (savedWidth >= 240 && savedWidth <= 640) rightPanel.style.width = savedWidth + "px";

let resizing = false;
resizer.addEventListener("mousedown", (e) => {
  resizing = true;
  resizer.classList.add("dragging");
  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";
  e.preventDefault();
});
document.addEventListener("mousemove", (e) => {
  if (!resizing) return;
  const w = Math.min(640, Math.max(240, window.innerWidth - e.clientX));
  rightPanel.style.width = w + "px";
});
document.addEventListener("mouseup", () => {
  if (!resizing) return;
  resizing = false;
  resizer.classList.remove("dragging");
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
  localStorage.setItem("right_panel_width", String(rightPanel.offsetWidth));
});

const btnToggle = $("btn-toggle-right");
function setPanelHidden(hidden) {
  document.body.classList.toggle("right-hidden", hidden);
  btnToggle.textContent = "«»";
  btnToggle.title = hidden ? "显示多条字符串发送区" : "隐藏多条字符串发送区";
  btnToggle.classList.toggle("panel-off", hidden);
  localStorage.setItem("right_panel_hidden", hidden ? "1" : "0");
}
btnToggle.onclick = () => setPanelHidden(!document.body.classList.contains("right-hidden"));
setPanelHidden(localStorage.getItem("right_panel_hidden") === "1");

// ---------------------------------------------------------------- 发送区高度拖拽
const sendResizer = $("send-resizer");
let sendResizeStart = null;
sendResizer.addEventListener("mousedown", (e) => {
  sendResizeStart = { y: e.clientY, h: sendInput.offsetHeight };
  sendResizer.classList.add("dragging");
  document.body.style.cursor = "row-resize";
  document.body.style.userSelect = "none";
  e.preventDefault();
});
document.addEventListener("mousemove", (e) => {
  if (!sendResizeStart) return;
  const h = Math.max(40, Math.min(window.innerHeight - 320, sendResizeStart.h + (sendResizeStart.y - e.clientY)));
  sendInput.style.height = h + "px";
});
document.addEventListener("mouseup", () => {
  if (!sendResizeStart) return;
  sendResizeStart = null;
  sendResizer.classList.remove("dragging");
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
  localStorage.setItem("send_input_height", String(sendInput.offsetHeight));
});
const savedSendH = parseInt(localStorage.getItem("send_input_height"), 10);
if (savedSendH >= 40 && savedSendH <= 800) sendInput.style.height = savedSendH + "px";

// 校验选项持久化
$("sel-checksum").value = localStorage.getItem("send_checksum") || "none";
$("sel-checksum").onchange = () => localStorage.setItem("send_checksum", $("sel-checksum").value);
$("sel-newline").value = localStorage.getItem("send_newline") || "lf";
$("sel-newline").onchange = () => localStorage.setItem("send_newline", $("sel-newline").value);
