@echo off
echo === 个人记账系统启动脚本 ===
echo.

REM Check if Python is installed
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo 错误: 未找到 Python，请先安装 Python 3.9+
    pause
    exit /b 1
)

REM Check if Node.js is installed
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo 错误: 未找到 Node.js，请先安装 Node.js 16+
    pause
    exit /b 1
)

echo 1. 安装后端依赖...
cd backend
pip install -r requirements.txt
if %errorlevel% neq 0 (
    echo 错误: 后端依赖安装失败
    pause
    exit /b 1
)
cd ..

echo.
echo 2. 安装前端依赖...
cd frontend
call npm install
if %errorlevel% neq 0 (
    echo 错误: 前端依赖安装失败
    pause
    exit /b 1
)
cd ..

echo.
echo 3. 启动后端服务...
cd backend
start "Backend Server" python app.py
cd ..

echo 后端服务启动在 http://localhost:5000

timeout /t 3 /nobreak >nul

echo.
echo 4. 启动前端服务...
cd frontend
start "Frontend Server" npm run dev
cd ..

echo 前端服务启动在 http://localhost:3000

echo.
echo === 服务启动完成 ===
echo 访问 http://localhost:3000 开始使用
echo.
pause