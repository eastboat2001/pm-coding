#!/bin/bash

echo "=== 个人记账系统启动脚本 ==="
echo ""

# Check if Python is installed
if ! command -v python3 &> /dev/null; then
    echo "错误: 未找到 Python3，请先安装 Python 3.9+"
    exit 1
fi

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "错误: 未找到 Node.js，请先安装 Node.js 16+"
    exit 1
fi

echo "1. 安装后端依赖..."
cd backend
pip3 install -r requirements.txt
if [ $? -ne 0 ]; then
    echo "错误: 后端依赖安装失败"
    exit 1
fi
cd ..

echo ""
echo "2. 安装前端依赖..."
cd frontend
npm install
if [ $? -ne 0 ]; then
    echo "错误: 前端依赖安装失败"
    exit 1
fi
cd ..

echo ""
echo "3. 启动后端服务..."
cd backend
python3 app.py &
BACKEND_PID=$!
cd ..

echo "后端服务 PID: $BACKEND_PID"
echo "后端服务启动在 http://localhost:5000"

sleep 3

echo ""
echo "4. 启动前端服务..."
cd frontend
npm run dev &
FRONTEND_PID=$!
cd ..

echo "前端服务 PID: $FRONTEND_PID"
echo "前端服务启动在 http://localhost:3000"

echo ""
echo "=== 服务启动完成 ==="
echo "访问 http://localhost:3000 开始使用"
echo ""
echo "按 Ctrl+C 停止所有服务"

# Wait for Ctrl+C
trap "kill $BACKEND_PID $FRONTEND_PID; exit 0" INT TERM
wait