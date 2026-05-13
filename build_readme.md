# CloudCLI 编译安装指南

## 环境要求

- Node.js >= 18.x
- npm >= 9.x
- Windows 操作系统

## 编译步骤

### 1. 安装依赖

```bash
npm install
```

### 2. 构建前端
```bash
npm ci
```

```bash
npm run build
```

构建完成后，静态文件将生成在 `dist/` 目录。

### 3. 配置端口

创建 `.env` 文件（或在环境变量中设置）：

```env
SERVER_PORT=8250
HOST=0.0.0.0
VITE_CONTEXT_WINDOW=160000
CONTEXT_WINDOW=160000
```

### 4. 启动服务器

```bash
node server/index.js
```

或使用一键启动脚本：

```bash
start-cloudcli.bat
```

## 访问地址

- 生产模式: http://localhost:8250
- 开发模式: http://localhost:5173 (需要运行 `npm run dev`)

## 常用命令

| 命令 | 说明 |
|------|------|
| `npm install` | 安装依赖 |
| `npm run build` | 构建前端 |
| `npm run server` | 启动后端服务器 |
| `npm run dev` | 开发模式（前后端同时启动） |
| `npm run typecheck` | TypeScript 类型检查 |
| `npm run lint` | ESLint 代码检查 |

## 一键启动脚本

`start-cloudcli.bat` 脚本功能：
- 自动检测并释放被占用的端口 8250
- 设置工作目录为 D:\
- 启动 CloudCLI 服务

## 卸载全局安装

如需卸载 npm 全局安装的包：

```bash
npm uninstall -g @cloudcli-ai/cloudcli
```

然后手动删除残留文件：
```
%APPDATA%\npm\cloudcli
%APPDATA%\npm\cloudcli.cmd
%APPDATA%\npm\cloudcli.ps1
```
