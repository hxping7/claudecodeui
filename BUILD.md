# Claude Code UI 编译构建文档

## 项目结构

```
├── server/           # 后端服务器代码
├── src/              # 前端源代码
├── shared/           # 前后端共享代码
├── public/           # 静态资源
├── dist/             # 构建输出目录
├── package.json      # 项目配置和依赖
├── vite.config.js    # Vite 构建配置
├── tsconfig.json     # TypeScript 配置
├── ecosystem.config.cjs  # PM2 配置
├── pm2-start.sh      # PM2 启动脚本
├── pm2-stop.sh       # PM2 停止脚本
├── pm2-restart.sh    # PM2 重启脚本
└── README.md         # 项目说明
```

## 系统要求

- **Node.js**: 16.x 或更高版本
- **npm**: 8.x 或更高版本
- **PM2** (可选): 用于生产环境部署

## 编译构建步骤

### 1. 克隆代码库

```bash
git clone https://github.com/siteboon/claudecodeui.git
cd claudecodeui
```

### 2. 安装依赖

```bash
npm install
```

安装过程中会自动执行 `postinstall` 脚本，修复 `node-pty` 依赖。

### 3. 构建项目

```bash
npm run build
```

构建完成后，静态文件会生成到 `dist/` 目录。

### 4. 运行开发服务器

```bash
npm run dev
```

开发服务器会在 `http://localhost:5173` 启动，支持热模块替换。

### 5. 运行生产服务器

#### 方法 A: 直接运行

```bash
npm start
```

这会先构建项目，然后启动服务器。

#### 方法 B: 使用 PM2 运行（推荐）

```bash
# 启动服务
./pm2-start.sh

# 停止服务
./pm2-stop.sh

# 重启服务
./pm2-restart.sh
```

## 环境变量

| 环境变量 | 说明 | 默认值 |
|----------|------|--------|
| SERVER_PORT | 服务器端口 | 3001 |
| DATABASE_PATH | 数据库路径 | ~/.cloudcli/auth.db |
| NODE_ENV | 运行环境 | production |

## 构建配置

### Vite 配置 (vite.config.js)

- **构建目标**: ES2015+
- **输出目录**: dist/
- **静态资源**: public/
- **代码分割**: 启用
- **源映射**: 生产环境禁用，开发环境启用

### TypeScript 配置 (tsconfig.json)

- **目标**: ES2015
- **模块**: ESNext
- **严格模式**: 启用
- **JSX**: React JSX

## 依赖管理

### 核心依赖

- **前端**: React 18, TypeScript, Vite, CodeMirror, XTerm.js
- **后端**: Express, WebSocket, Node.js, node-pty, SQLite
- **AI 集成**: Claude SDK, Gemini, Cursor, Codex

### 开发依赖

- **构建工具**: Vite, TypeScript, ESLint
- **测试工具**: Husky (git hooks)
- **代码质量**: ESLint, Prettier

## 部署方法

### 生产环境部署

1. **构建项目**:
   ```bash
   npm run build
   ```

2. **使用 PM2 启动**:
   ```bash
   ./pm2-start.sh
   ```

3. **设置开机自启**:
   ```bash
   pm2 startup
   pm2 save
   ```

### 多环境部署

1. **开发环境**:
   ```bash
   npm run dev
   ```

2. **测试环境**:
   ```bash
   NODE_ENV=test npm start
   ```

3. **生产环境**:
   ```bash
   NODE_ENV=production npm start
   ```

## 常见问题和解决方案

### 1. 端口冲突

**问题**: 启动时出现 `EADDRINUSE` 错误

**解决方案**:
```bash
# 查找占用端口的进程
lsof -i :8250

# 终止占用端口的进程
kill -9 <PID>

# 或使用 fuser
fuser -k 8250/tcp
```

### 2. 依赖安装失败

**问题**: `npm install` 失败

**解决方案**:
```bash
# 清除 npm 缓存
npm cache clean --force

# 重新安装
npm install
```

### 3. node-pty 安装问题

**问题**: node-pty 编译失败

**解决方案**:
- 确保安装了构建工具: `sudo apt-get install build-essential`
- 项目会自动执行 `scripts/fix-node-pty.js` 脚本修复

### 4. 构建失败

**问题**: `npm run build` 失败

**解决方案**:
- 检查 TypeScript 类型错误: `npm run typecheck`
- 检查代码风格: `npm run lint`

## 性能优化

1. **代码分割**: Vite 自动代码分割，减少初始加载时间
2. **缓存策略**: 静态资源使用哈希文件名，支持长期缓存
3. **服务器优化**: Express 服务器使用 Gzip 压缩
4. **PM2 配置**: 内存限制 1G，超限自动重启

## 监控和日志

### PM2 监控

```bash
# 查看状态
pm2 status

# 查看日志
pm2 logs claudecodeui

# 监控面板
pm2 monit
```

### 日志文件

日志文件位于 `logs/` 目录:
- `logs/combined.log`: 所有日志
- `logs/out.log`: 标准输出
- `logs/error.log`: 错误日志

## 安全注意事项

1. **API 密钥**: 不要将 API 密钥硬编码到代码中
2. **HTTPS**: 生产环境建议启用 HTTPS
3. **CORS**: 已配置适当的 CORS 策略
4. **身份验证**: 实现了基于 JWT 的身份验证

## 版本管理

- **版本号**: 遵循语义化版本规范
- **发布流程**: 使用 `npm run release` 命令
- **git 标签**: 每次发布时创建 git 标签

## 故障排查

### 1. 服务器无法启动

- 检查端口是否被占用
- 检查数据库文件权限
- 查看错误日志: `pm2 logs claudecodeui`

### 2. 前端页面无法加载

- 检查服务器是否运行: `pm2 status`
- 检查网络连接
- 查看浏览器控制台错误

### 3. AI 模型连接失败

- 检查 API 密钥配置
- 检查网络连接
- 查看服务器日志中的错误信息

## 维护建议

1. **定期更新依赖**: `npm update`
2. **备份数据库**: 定期备份 `~/.cloudcli/auth.db`
3. **监控日志**: 定期检查错误日志
4. **性能监控**: 使用 PM2 监控内存和 CPU 使用情况

## 构建命令总结

| 命令 | 说明 |
|------|------|
| `npm install` | 安装依赖 |
| `npm run build` | 构建项目 |
| `npm run dev` | 启动开发服务器 |
| `npm start` | 启动生产服务器 |
| `npm run typecheck` | 检查 TypeScript 类型 |
| `npm run lint` | 检查代码风格 |
| `./pm2-start.sh` | 使用 PM2 启动 |
| `./pm2-stop.sh` | 使用 PM2 停止 |
| `./pm2-restart.sh` | 使用 PM2 重启 |
