# Claude Code Web - PAM 多用户 Docker 部署指南

针对 Ubuntu 编译服务器（20个用户）的完整部署方案。

## 架构概览

```
┌─────────────────────────────────────────────────────────────┐
│                      宿主机 (Ubuntu)                          │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐        ┌──────────┐   │
│  │ user1   │ │ user2   │ │ user3   │  ...   │ user20   │   │
│  │ /home/1 │ │ /home/2 │ │ /home/3 │        │ /home/20 │   │
│  └────┬────┘ └────┬────┘ └────┬────┘        └────┬─────┘   │
│       └────────────┴───────────┴──────────────────┘         │
│                           │                                 │
│                    Docker 共享卷挂载                          │
│                           │                                 │
│       ┌───────────────────┼───────────────────┐             │
│       ▼                   ▼                   ▼             │
│  ┌──────────────────────────────────────────────────┐      │
│  │         Claude Code Web 容器                       │      │
│  │  ┌────────────────────────────────────────────┐  │      │
│  │  │  PAM 认证模块 (getent + su)                  │  │      │
│  │  │  - 读取 /etc/passwd, /etc/shadow            │  │      │
│  │  │  - 验证 Linux 用户密码                       │  │      │
│  │  └────────────────────────────────────────────┘  │      │
│  │  ┌────────────────────────────────────────────┐  │      │
│  │  │  用户工作区 (/host_home/user{1-20})          │  │      │
│  │  │  - user1 只能看到 /host_home/user1          │  │      │
│  │  │  - user2 只能看到 /host_home/user2          │  │      │
│  │  └────────────────────────────────────────────┘  │      │
│  └──────────────────────────────────────────────────┘      │
└─────────────────────────────────────────────────────────────┘
```

## 部署步骤

### 1. 前提条件

确保宿主机已安装：
- Docker 20.10+
- Docker Compose 2.0+
- 20个Linux用户已创建（UID >= 1000）

检查用户：
```bash
getent passwd | awk -F: '$3 >= 1000 && $3 < 65534 {print $1}'
```

### 2. 部署文件

已创建以下文件：
- `docker-compose.pam.yml` - Docker Compose 配置
- `Dockerfile.pam` - 支持PAM的Docker镜像
- `start-pam-docker.sh` - 一键启动脚本

### 3. 启动服务

```bash
# 给启动脚本执行权限
chmod +x start-pam-docker.sh

# 运行部署脚本（建议用root用户）
sudo ./start-pam-docker.sh
```

或者直接使用docker-compose：
```bash
# 构建镜像
docker-compose -f docker-compose.pam.yml build

# 启动服务
docker-compose -f docker-compose.pam.yml up -d

# 查看日志
docker-compose -f docker-compose.pam.yml logs -f
```

### 4. 验证部署

访问 `http://<服务器IP>:3000`

首次使用：
1. 注册第一个用户（自动成为superadmin）
2. 该用户与Linux系统用户无关，使用独立的用户名/密码
3. 后续用户可用Linux用户名和密码登录

## 工作原理

### PAM认证流程

1. 用户在Web输入Linux用户名和密码
2. 容器内调用 `getent passwd <username>` 检查用户存在
3. 调用 `su - <username> -c "echo <token>"` 验证密码
4. 成功后，从 `/etc/passwd` 获取用户的home目录、UID、GID
5. 生成JWT令牌，包含用户的home_dir、uid、gid

### 文件权限隔离

- **路径限制**：每个用户只能访问其home_dir下的项目
- **UID/GID执行**：文件操作以用户的实际UID/GID执行
- **验证机制**：`validateWorkspacePath` 防止目录遍历攻击

### 容器内路径映射

| 宿主机路径 | 容器内路径 | 用途 |
|-----------|-----------|------|
| /home/user1 | /host_home/user1 | user1的工作区 |
| /home/user2 | /host_home/user2 | user2的工作区 |
| /etc/passwd | /etc/passwd | 用户数据库 |
| /etc/shadow | /etc/shadow | 密码验证 |

## 安全注意事项

### ⚠️ 重要安全提示

1. **privileged: true** 的风险
   - 当前配置使用 `privileged: true` 以支持 `su` 命令
   - 这意味着容器拥有主机的完全访问权限
   - **替代方案**：使用 `cap_add` 限制权限（见下方配置）

2. **/etc/shadow 挂载**
   - 容器可以读取主机所有用户的密码哈希
   - 确保Docker守护进程安全配置
   - 限制可以访问Docker的用户

3. **文件所有权**
   - 容器内创建的文件在宿主机上以原始UID/GID保存
   - 确保宿主机上没有UID冲突

### 更安全的配置（推荐用于生产）

```yaml
# docker-compose.pam.yml 安全版
services:
  claude-code-web:
    # 不使用 privileged
    privileged: false
    cap_add:
      - CAP_SETUID
      - CAP_SETGID
      - CAP_AUDIT_WRITE
    security_opt:
      - no-new-privileges:true
    # 其他配置...
```

## 故障排除

### 问题1：su命令失败

**症状**：登录时提示认证失败，但密码正确

**检查**：
```bash
# 进入容器
docker exec -it claude-code-web bash

# 测试getent
getent passwd user1

# 测试su（需要交互式shell）
su - user1 -c "echo test"
```

**解决**：
- 确保容器内 `login` 包已安装
- 检查 `/etc/pam.d/su` 配置

### 问题2：用户看不到自己的文件

**症状**：登录后home目录为空

**检查**：
```bash
# 在容器内检查挂载
docker exec claude-code-web ls -la /host_home/

# 检查权限
docker exec claude-code-web ls -la /host_home/user1
```

**解决**：
- 确保宿主机 `/home` 正确挂载到容器 `/host_home`
- 检查宿主机home目录权限

### 问题3：文件操作权限错误

**症状**：无法创建文件或目录

**检查**：
```bash
# 查看容器日志
docker-compose -f docker-compose.pam.yml logs -f
```

**解决**：
- 确保宿主机home目录对相应用户可写
- 检查SELinux/AppArmor设置

## 用户管理

### 添加新的Linux用户

1. 在宿主机创建用户：
```bash
sudo useradd -m -s /bin/bash newuser
sudo passwd newuser
```

2. 用户下次登录时自动生效（无需重启容器）

### 设置管理员

在 `docker-compose.pam.yml` 中设置：
```yaml
environment:
  - LINUX_ADMIN_USERS=admin,user1,user2
```

或者在superadmin界面中配置。

### 禁用用户

在Web管理界面中将用户标记为 `is_active = false`，用户的Linux账户不受影响，但无法登录Web界面。

## 性能优化

### 大目录处理

如果用户home目录很大（如编译输出）：

1. 使用Docker volume排除不必要的目录：
```yaml
volumes:
  - /home:/host_home:rw
  - /home/user1/build_cache:/host_home/user1/build_cache:delegated
```

2. 或让用户在项目设置中选择子目录作为工作区

### 资源限制

```yaml
services:
  claude-code-web:
    deploy:
      resources:
        limits:
          cpus: '4.0'
          memory: 8G
        reservations:
          cpus: '2.0'
          memory: 4G
```

## 备份策略

### 需要备份的内容

1. **数据库** (`./data` 卷)
   - 用户元数据、项目配置、会话历史

2. **用户数据** (`/home/*`)
   - 实际代码和文件（可选，如果已有其他备份方案）

### 自动备份脚本

```bash
#!/bin/bash
# backup.sh
DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR=/backup/claude-code-web

# 备份数据库
docker cp claude-code-web:/app/data "$BACKUP_DIR/data_$DATE"

# 可选：备份用户home（可能很大）
# tar czf "$BACKUP_DIR/homes_$DATE.tar.gz" /home
```

## 更新维护

### 更新应用

```bash
# 拉取最新代码
git pull origin main

# 重建镜像
docker-compose -f docker-compose.pam.yml build --no-cache

# 重启服务
docker-compose -f docker-compose.pam.yml up -d
```

### 查看版本

```bash
docker exec claude-code-web node --version
docker exec claude-code-web npm list claude-code
```

## 相关代码位置

- PAM认证：`server/modules/auth/linux-pam-auth.ts`
- 用户数据库：`server/modules/database/repositories/users.ts`
- 路径验证：`server/shared/utils.ts` (validateWorkspacePath)
- 文件操作：`server/utils/fileOpsAsUser.js`
