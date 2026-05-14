#!/bin/bash
#
# Claude Code Web - PAM 多用户模式 Docker 启动脚本
#
# 此脚本用于在Ubuntu编译服务器上部署支持20个Linux用户的多用户环境
#

set -e

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN}  Claude Code Web - PAM 多用户模式部署${NC}"
echo -e "${GREEN}============================================${NC}"

# 检查是否以root运行
if [ "$EUID" -ne 0 ]; then
   echo -e "${YELLOW}警告：建议以root用户运行此脚本以确保PAM认证正常工作${NC}"
   echo -e "${YELLOW}当前用户: $(whoami)${NC}"
   echo ""
fi

# 检查Docker是否安装
if ! command -v docker &> /dev/null; then
    echo -e "${RED}错误：Docker未安装${NC}"
    exit 1
fi

if ! command -v docker-compose &> /dev/null && ! docker compose version &> /dev/null; then
    echo -e "${RED}错误：Docker Compose未安装${NC}"
    exit 1
fi

# 检查必要的文件
REQUIRED_FILES=("/etc/passwd" "/etc/group" "/etc/shadow")
for file in "${REQUIRED_FILES[@]}"; do
    if [ ! -f "$file" ]; then
        echo -e "${RED}错误：缺少必要文件 $file${NC}"
        exit 1
    fi
done

# 检查/home目录
if [ ! -d "/home" ]; then
    echo -e "${RED}错误：/home目录不存在${NC}"
    exit 1
fi

# 显示当前配置的用户
echo ""
echo -e "${GREEN}检测到以下系统用户（将在Web中可用）：${NC}"
echo "--------------------------------------------"
getent passwd | awk -F: '$3 >= 1000 && $3 < 65534 {print "  - " $1 " (home: " $6 ")"}'
echo "--------------------------------------------"
echo ""

# 创建数据目录
mkdir -p ./data

# 构建并启动
echo -e "${GREEN}正在构建Docker镜像...${NC}"
if docker-compose -f docker-compose.pam.yml build; then
    echo -e "${GREEN}镜像构建成功！${NC}"
else
    echo -e "${RED}镜像构建失败${NC}"
    exit 1
fi

echo ""
echo -e "${GREEN}正在启动服务...${NC}"
docker-compose -f docker-compose.pam.yml up -d

echo ""
echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN}  部署完成！${NC}"
echo -e "${GREEN}============================================${NC}"
echo ""
echo "访问地址: http://localhost:3000"
echo ""
echo "首次使用说明："
echo "  1. 打开浏览器访问 http://<服务器IP>:3000"
echo "  2. 注册第一个用户（将成为superadmin）"
echo "  3. 后续用户可以使用他们的Linux用户名和密码直接登录"
echo "  4. 每个用户登录后将自动使用其Linux home目录作为工作区"
echo ""
echo "查看日志: docker-compose -f docker-compose.pam.yml logs -f"
echo "停止服务: docker-compose -f docker-compose.pam.yml down"
echo ""
