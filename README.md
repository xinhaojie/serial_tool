# 串口调试工具 (serial_tool)

参考 SSCOM 界面复刻的串口/网络调试工具，使用 **Rust + Tauri 2** 开发，前端为原生 HTML/JS，后端 Rust 通过 Tauri command 与事件通信。

![license](https://img.shields.io/badge/license-MIT-green)

## 功能特性

### 连接类型
- **串口**：自动枚举 COM 口，波特率 300~1500000，校验/数据位/停止位可配
- **TCP 客户端**：连接远程 IP/域名 + 端口
- **TCP 服务端**：可选择监听网卡（0.0.0.0 / 127.0.0.1 / 各网卡 IP），支持多客户端接入
- **UDP**：可指定出口网卡（绑定网卡 IP 强制发包出口），支持远程对端收发

### 接收区
- 毫秒级时标显示，Hex 显示切换，停止显示、清空、保存接收数据到文件
- 收/发字节计数、计数清零

### 发送区
- Hex 发送、附加换行（`\n` LF / `\r\n` CRLF 可选）
- **加校验**：None / ModbusCRC16 / CDIT-CRC16(CRC16-CCITT-FALSE) / CRC32 / ADD8 / CRC8 / ADD16，发送时自动附加
- 定时发送（间隔可设）

### 多条字符串发送区
- 每条：内容 / 间隔ms / 注释，可单条发送、勾选、行删除
- **批量发送**：按顺序发送所有勾选的行（间隔用每条自己的间隔）
- **循环发送**：循环发送勾选的行，运行期间锁定列表编辑，连接断开自动停止
- 列表可加载/保存为文本文件（`内容<TAB>间隔ms<TAB>注释`，# 开头为注释行），localStorage 自动持久化

### 其他
- 暗黑 / 浅色主题（选项菜单切换，持久化）
- 界面布局可调：右侧面板显隐 + 拖拽宽度、发送区拖拽高度
- 全部连接参数（类型、串口参数、TCP/UDP 参数）自动持久化
- 帮助菜单：关于 / MIT License
- 单文件运行：首次以管理员运行时自动迁移 `WebView2Loader.dll` 到 System32

## 构建说明

### 环境要求
- Rust（stable-x86_64-pc-windows-gnu 工具链）
- Node.js（仅用于安装 Tauri CLI）
- w64devkit 或其他 MinGW 工具链（提供 `as.exe` / `windres.exe` / `dlltool.exe`）

### 步骤

```bash
npm install          # 安装 @tauri-apps/cli（前端为纯静态资源，无需构建）
cd src-tauri
cargo build --release
```

产物：`src-tauri/target/release/serial_tool.exe`

> windows-gnu 工具链下 WebView2Loader 为动态链接，发布时需将 `WebView2Loader.dll`
> 放在 exe 同目录（程序首次以管理员运行会自动迁移到 System32，此后单文件即可运行）。

## 目录结构

```
├── ui/                  # 前端（纯 HTML/CSS/JS，构建时嵌入 exe）
├── src-tauri/           # Rust 后端（serialport 4 + std::net）
│   ├── src/main.rs      # 串口/TCP/UDP 会话管理、Tauri 命令
│   ├── capabilities/    # Tauri 权限配置
│   └── icons/           # 应用图标
├── LICENSE              # MIT
└── README.md
```

## 许可证

[MIT](LICENSE) © 2026 心情 (xinhaojie@foxmail.com)
