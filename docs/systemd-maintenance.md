# CloudCLI（systemd）部署与维护说明

适用场景：PAM 多租户（Linux 用户登录）+ systemd 后台服务运行。

## 1. 运行状态检查

### 1.1 systemd 服务是否存活

```bash
systemctl is-enabled cloudcli.service
systemctl is-active cloudcli.service
systemctl --no-pager --full status cloudcli.service
```

### 1.2 查看实时日志

```bash
journalctl -u cloudcli.service -f
```

常见关键词：
- `SERVER_PORT`：确认监听端口是否符合预期
- `DATABASE_PATH`：确认数据库文件路径是否符合预期（避免因为 root/home 不同导致“看起来数据清空”）
- `WebSocket authenticated` / `Chat WebSocket connected`：确认 WS 连接正常

### 1.3 HTTP 健康检查

服务端提供健康检查接口：

```bash
curl -sS http://127.0.0.1:8250/health
```

预期返回 JSON，包含 `status: "ok"` 和 `timestamp`。

### 1.4 数据是否走对库

systemd unit 中会显式设置 `DATABASE_PATH`。检查当前生效配置：

```bash
systemctl show cloudcli.service -p Environment
```

如果看到 `DATABASE_PATH=/var/lib/cloudcli/auth.db`（或你自定义路径），说明服务正在使用固定库。

## 2. 数据持久化位置（你需要备份什么）

本项目持久化数据分两类：

### 2.1 服务级数据库（强烈建议固定路径）

SQLite（better-sqlite3）数据库：`auth.db`
- 保存：users / projects / sessions / credentials / api-keys 等
- 多租户隔离：依赖表内 `user_id`

建议路径（systemd unit 内显式配置）：
- `/var/lib/cloudcli/auth.db`

### 2.2 用户级 provider 原始数据（PAM 多用户天然隔离）

各 provider 的原始会话文件通常在每个 Linux 用户的 home 下，例如：
- `/home/<user>/.claude/...`
- `/home/<user>/.cursor/...`
- `/home/<user>/.codex/...`
- `/home/<user>/.gemini/...`

服务通过 watcher 同步这些目录，并把索引写入 `auth.db`。

## 3. 更新源码后的维护流程

你的理解基本正确：通常就是“更新代码 → 构建 → 重启服务”。

推荐流程如下（假设代码目录为 `/home/hxp/code/tools/claudecodeui`）：

### 3.1 拉取更新（可选）

```bash
cd /home/hxp/code/tools/claudecodeui
git pull
```

### 3.2 安装依赖并构建

```bash
cd /home/hxp/code/tools/claudecodeui
npm ci
npm run build
```

说明：
- `npm ci` 依赖 lockfile，适合生产环境可重复构建。
- 如果遇到 better-sqlite3 编译问题，需要满足系统编译工具链（g++ 支持 C++20）与网络可用（prebuild-install 拉取预编译包）。

### 3.3 重启服务

```bash
systemctl restart cloudcli.service
systemctl --no-pager --full status cloudcli.service
```

### 3.4 快速验证

```bash
curl -sS http://127.0.0.1:8250/health
journalctl -u cloudcli.service -n 200 --no-pager
```

## 4. 配置变更与注意事项

### 4.1 修改端口/数据库路径

修改 systemd unit：
- `/etc/systemd/system/cloudcli.service`

修改后执行：

```bash
systemctl daemon-reload
systemctl restart cloudcli.service
```

### 4.2 PAM 多租户写入用户 home 的权限前提

若启用“按 `req.user.uid/gid` 写入用户 home”（例如写 `/home/test1/.claude/settings.json`）：
- 服务进程必须具备切换 uid/gid 的能力（常见做法：systemd 以 root 启动服务）
- 否则会出现 `spawn EPERM`

## 5. 备份与回滚

### 5.1 备份数据库

建议停服务后备份（避免 WAL/事务不一致）：

```bash
systemctl stop cloudcli.service
cp -a /var/lib/cloudcli/auth.db /var/lib/cloudcli/auth.db.bak.$(date +%F-%H%M%S)
systemctl start cloudcli.service
```

### 5.2 回滚到旧版本代码

```bash
cd /home/hxp/code/tools/claudecodeui
git checkout <old_commit_or_tag>
npm ci
npm run build
systemctl restart cloudcli.service
```

## 6. 相关仓库文件（便于定位）

- systemd 部署脚本：file:deploy-systemd.sh
- 数据库默认路径逻辑：file:server/load-env.js
- 数据库连接与迁移逻辑：file:server/modules/database/connection.ts

