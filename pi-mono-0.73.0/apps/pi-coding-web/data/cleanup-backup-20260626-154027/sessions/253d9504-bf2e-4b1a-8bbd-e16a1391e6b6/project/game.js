// 霓虹蛇 - Neon Snake Game Logic
class NeonSnakeGame {
    constructor() {
        // 游戏配置
        this.canvas = document.getElementById('gameCanvas');
        this.ctx = this.canvas.getContext('2d');
        this.miniCanvas = document.getElementById('miniMap');
        this.miniCtx = this.miniCanvas.getContext('2d');
        
        // 游戏设置
        this.gridSize = 20;
        this.cellSize = 20;
        this.gameSpeed = 150; // 毫秒
        
        // 游戏状态
        this.gameState = {
            score: 0,
            highScore: 0,
            level: 1,
            isRunning: false,
            isPaused: false,
            startTime: null,
            elapsedTime: 0
        };
        
        // 蛇
        this.snake = {
            body: [
                {x: 10, y: 10},
                {x: 9, y: 10},
                {x: 8, y: 10}
            ],
            direction: {x: 1, y: 0},
            nextDirection: {x: 1, y: 0},
            growing: false,
            color: '#00ff9f'
        };
        
        // 食物
        this.food = {
            position: {x: 15, y: 15},
            type: 'normal', // normal, bonus, special
            spawnTime: 0,
            color: '#ff00ff'
        };
        
        // 特殊效果
        this.particles = [];
        this.trailEffects = [];
        
        // 初始化
        this.init();
    }
    
    init() {
        // 设置画布大小
        this.canvas.width = this.gridSize * this.cellSize;
        this.canvas.height = this.gridSize * this.cellSize;
        
        // 初始化迷你地图
        this.initMiniMap();
        
        // 绑定事件
        this.bindEvents();
        
        // 加载最高分
        this.loadHighScore();
        
        // 更新UI
        this.updateUI();
        
        // 初始渲染
        this.render();
        
        // 显示开始界面
        this.showStartOverlay();
        
        console.log('霓虹蛇游戏初始化完成');
    }
    
    initMiniMap() {
        const scale = this.miniCanvas.width / this.gridSize;
        this.miniScale = scale;
    }
    
    bindEvents() {
        // 键盘控制
        document.addEventListener('keydown', (e) => this.handleKeyPress(e));
        
        // 移动端控制按钮
        document.querySelectorAll('.control-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const direction = e.target.dataset.direction;
                if (direction) {
                    this.changeDirection(direction);
                } else if (e.target.dataset.action === 'pause') {
                    this.togglePause();
                } else if (e.target.dataset.action === 'reset') {
                    this.resetGame();
                }
            });
        });
        
        // 重新开始按钮
        document.getElementById('restartBtn')?.addEventListener('click', () => this.resetGame());
        
        // 窗口大小改变
        window.addEventListener('resize', () => this.handleResize());
    }
    
    handleKeyPress(e) {
        const key = e.key.toLowerCase();
        
        // 游戏控制键
        if (key === ' ' || key === 'p') {
            e.preventDefault();
            if (!this.gameState.isRunning) {
                // 如果游戏未开始，按空格键开始游戏
                this.startGame();
            } else {
                // 如果游戏已开始，按空格键暂停/继续
                this.togglePause();
            }
            return;
        }
        
        if (key === 'r') {
            this.resetGame();
            return;
        }
        
        if (key === 'enter' && !this.gameState.isRunning) {
            this.startGame();
            return;
        }
        
        // 方向键
        const directionMap = {
            'arrowup': 'up',
            'arrowdown': 'down',
            'arrowleft': 'left',
            'arrowright': 'right',
            'w': 'up',
            's': 'down',
            'a': 'left',
            'd': 'right'
        };
        
        if (directionMap[key]) {
            e.preventDefault();
            this.changeDirection(directionMap[key]);
        }
    }
    
    changeDirection(direction) {
        if (!this.gameState.isRunning || this.gameState.isPaused) return;
        
        const directions = {
            'up': {x: 0, y: -1},
            'down': {x: 0, y: 1},
            'left': {x: -1, y: 0},
            'right': {x: 1, y: 0}
        };
        
        const newDir = directions[direction];
        if (!newDir) return;
        
        // 防止反向移动
        if (this.snake.direction.x + newDir.x === 0 && 
            this.snake.direction.y + newDir.y === 0) {
            return;
        }
        
        this.snake.nextDirection = newDir;
    }
    
    startGame() {
        if (this.gameState.isRunning) return;
        
        this.gameState.isRunning = true;
        this.gameState.isPaused = false;
        this.gameState.startTime = Date.now();
        
        // 隐藏覆盖层
        document.getElementById('gameOverlay')?.classList.add('hidden');
        document.getElementById('gameOverlay')?.classList.remove('visible');
        
        // 开始游戏循环
        this.gameLoop();
        
        // 开始计时器
        this.startTimer();
        
        console.log('游戏开始');
    }
    
    togglePause() {
        if (!this.gameState.isRunning) return;
        
        this.gameState.isPaused = !this.gameState.isPaused;
        
        if (this.gameState.isPaused) {
            this.showPauseOverlay();
            this.stopTimer();
        } else {
            this.hidePauseOverlay();
            this.startTimer();
        }
    }
    
    showPauseOverlay() {
        const overlay = document.getElementById('gameOverlay');
        const title = overlay?.querySelector('.overlay-title');
        const subtitle = overlay?.querySelector('.overlay-subtitle');
        const icon = overlay?.querySelector('.overlay-icon');
        
        if (overlay && title && subtitle && icon) {
            title.textContent = '游戏暂停';
            subtitle.textContent = '按空格键或P继续游戏';
            icon.textContent = '⏸️';
            overlay.classList.remove('hidden');
            overlay.classList.add('visible');
        }
    }
    
    hidePauseOverlay() {
        document.getElementById('gameOverlay')?.classList.add('hidden');
        document.getElementById('gameOverlay')?.classList.remove('visible');
    }
    
    resetGame() {
        // 重置蛇
        this.snake.body = [
            {x: 10, y: 10},
            {x: 9, y: 10},
            {x: 8, y: 10}
        ];
        this.snake.direction = {x: 1, y: 0};
        this.snake.nextDirection = {x: 1, y: 0};
        this.snake.growing = false;
        
        // 重置游戏状态
        this.gameState.score = 0;
        this.gameState.level = 1;
        this.gameState.isRunning = false;
        this.gameState.isPaused = false;
        this.gameState.elapsedTime = 0;
        
        // 生成新食物
        this.spawnFood();
        
        // 清除效果
        this.particles = [];
        this.trailEffects = [];
        
        // 更新UI
        this.updateUI();
        
        // 重新渲染
        this.render();
        
        // 显示开始界面
        this.showStartOverlay();
        
        console.log('游戏已重置');
    }
    
    showStartOverlay() {
        const overlay = document.getElementById('gameOverlay');
        const title = overlay?.querySelector('.overlay-title');
        const subtitle = overlay?.querySelector('.overlay-subtitle');
        const icon = overlay?.querySelector('.overlay-icon');
        
        if (overlay && title && subtitle && icon) {
            title.textContent = '准备开始';
            subtitle.textContent = '按空格键或点击开始游戏';
            icon.textContent = '🐍';
            overlay.classList.remove('hidden');
            overlay.classList.add('visible');
        }
    }
    
    gameLoop() {
        if (!this.gameState.isRunning || this.gameState.isPaused) return;
        
        // 更新游戏状态
        this.update();
        
        // 渲染游戏
        this.render();
        
        // 继续循环
        setTimeout(() => this.gameLoop(), this.gameSpeed);
    }
    
    update() {
        // 更新蛇的方向
        this.snake.direction = {...this.snake.nextDirection};
        
        // 计算新头部位置
        const head = this.snake.body[0];
        const newHead = {
            x: head.x + this.snake.direction.x,
            y: head.y + this.snake.direction.y
        };
        
        // 检查边界碰撞
        if (this.checkBoundaryCollision(newHead)) {
            this.gameOver();
            return;
        }
        
        // 检查自身碰撞
        if (this.checkSelfCollision(newHead)) {
            this.gameOver();
            return;
        }
        
        // 移动蛇
        this.snake.body.unshift(newHead);
        
        // 检查食物碰撞
        if (this.checkFoodCollision(newHead)) {
            this.eatFood();
        } else {
            // 如果没有吃到食物，移除尾部
            this.snake.body.pop();
        }
        
        // 更新粒子
        this.updateParticles();
        
        // 更新尾迹效果
        this.updateTrailEffects();
        
        // 更新游戏时间
        if (this.gameState.startTime) {
            this.gameState.elapsedTime = Math.floor((Date.now() - this.gameState.startTime) / 1000);
        }
        
        // 更新UI
        this.updateUI();
    }
    
    checkBoundaryCollision(position) {
        return position.x < 0 || position.x >= this.gridSize ||
               position.y < 0 || position.y >= this.gridSize;
    }
    
    checkSelfCollision(position) {
        return this.snake.body.some(segment => 
            segment.x === position.x && segment.y === position.y
        );
    }
    
    checkFoodCollision(position) {
        return position.x === this.food.position.x && 
               position.y === this.food.position.y;
    }
    
    eatFood() {
        // 增加分数
        const points = this.food.type === 'bonus' ? 50 : 
                      this.food.type === 'special' ? 100 : 10;
        this.gameState.score += points;
        
        // 增加蛇的长度
        this.snake.growing = true;
        
        // 创建吃食物的粒子效果
        this.createEatEffect();
        
        // 生成新食物
        this.spawnFood();
        
        // 检查是否升级
        this.checkLevelUp();
        
        // 更新最高分
        this.updateHighScore();
        
        console.log(`吃到食物！得分：${points}，总分：${this.gameState.score}`);
    }
    
    createEatEffect() {
        const head = this.snake.body[0];
        const pixelX = head.x * this.cellSize + this.cellSize / 2;
        const pixelY = head.y * this.cellSize + this.cellSize / 2;
        
        // 创建多个粒子
        for (let i = 0; i < 15; i++) {
            const angle = (Math.PI * 2 * i) / 15;
            const speed = 2 + Math.random() * 3;
            
            this.particles.push({
                x: pixelX,
                y: pixelY,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed,
                life: 1,
                decay: 0.02 + Math.random() * 0.02,
                color: this.food.color,
                size: 2 + Math.random() * 3
            });
        }
    }
    
    updateParticles() {
        for (let i = this.particles.length - 1; i >= 0; i--) {
            const particle = this.particles[i];
            
            // 更新位置
            particle.x += particle.vx;
            particle.y += particle.vy;
            
            // 更新生命值
            particle.life -= particle.decay;
            
            // 更新大小
            particle.size *= 0.98;
            
            // 移除死亡粒子
            if (particle.life <= 0) {
                this.particles.splice(i, 1);
            }
        }
    }
    
    updateTrailEffects() {
        // 添加尾迹效果
        if (this.snake.body.length > 0) {
            const tail = this.snake.body[this.snake.body.length - 1];
            this.trailEffects.push({
                x: tail.x * this.cellSize + this.cellSize / 2,
                y: tail.y * this.cellSize + this.cellSize / 2,
                life: 1,
                decay: 0.05
            });
        }
        
        // 更新现有尾迹
        for (let i = this.trailEffects.length - 1; i >= 0; i--) {
            const trail = this.trailEffects[i];
            trail.life -= trail.decay;
            
            if (trail.life <= 0) {
                this.trailEffects.splice(i, 1);
            }
        }
    }
    
    checkLevelUp() {
        const newLevel = Math.floor(this.gameState.score / 100) + 1;
        if (newLevel > this.gameState.level) {
            this.gameState.level = newLevel;
            this.gameSpeed = Math.max(80, 150 - (newLevel - 1) * 10);
            
            // 创建升级效果
            this.createLevelUpEffect();
            
            console.log(`升级到第 ${newLevel} 级！速度：${this.gameSpeed}ms`);
        }
    }
    
    createLevelUpEffect() {
        // 在屏幕边缘创建闪光效果
        for (let i = 0; i < 30; i++) {
            const edge = Math.floor(Math.random() * 4);
            let x, y;
            
            switch (edge) {
                case 0: // 上
                    x = Math.random() * this.canvas.width;
                    y = 0;
                    break;
                case 1: // 下
                    x = Math.random() * this.canvas.width;
                    y = this.canvas.height;
                    break;
                case 2: // 左
                    x = 0;
                    y = Math.random() * this.canvas.height;
                    break;
                case 3: // 右
                    x = this.canvas.width;
                    y = Math.random() * this.canvas.height;
                    break;
            }
            
            this.particles.push({
                x: x,
                y: y,
                vx: (Math.random() - 0.5) * 5,
                vy: (Math.random() - 0.5) * 5,
                life: 1,
                decay: 0.01,
                color: '#00ff9f',
                size: 3 + Math.random() * 4
            });
        }
    }
    
    spawnFood() {
        // 随机位置
        let position;
        do {
            position = {
                x: Math.floor(Math.random() * this.gridSize),
                y: Math.floor(Math.random() * this.gridSize)
            };
        } while (this.isPositionOccupied(position));
        
        // 随机类型
        const rand = Math.random();
        if (rand < 0.1) {
            this.food.type = 'special';
            this.food.color = '#ff00ff';
        } else if (rand < 0.3) {
            this.food.type = 'bonus';
            this.food.color = '#00d4ff';
        } else {
            this.food.type = 'normal';
            this.food.color = '#ff00ff';
        }
        
        this.food.position = position;
        this.food.spawnTime = Date.now();
    }
    
    isPositionOccupied(position) {
        // 检查是否与蛇身体重叠
        if (this.snake.body.some(segment => 
            segment.x === position.x && segment.y === position.y
        )) {
            return true;
        }
        
        return false;
    }
    
    gameOver() {
        this.gameState.isRunning = false;
        this.stopTimer();
        
        // 更新最高分
        this.updateHighScore();
        
        // 显示游戏结束界面
        this.showGameOverOverlay();
        
        // 创建游戏结束效果
        this.createGameOverEffect();
        
        console.log(`游戏结束！最终得分：${this.gameState.score}`);
    }
    
    showGameOverOverlay() {
        const overlay = document.getElementById('gameOverlay');
        const title = overlay?.querySelector('.overlay-title');
        const subtitle = overlay?.querySelector('.overlay-subtitle');
        const icon = overlay?.querySelector('.overlay-icon');
        
        if (overlay && title && subtitle && icon) {
            title.textContent = '游戏结束';
            subtitle.textContent = `最终得分：${this.gameState.score}`;
            icon.textContent = '💀';
            overlay.classList.remove('hidden');
            overlay.classList.add('visible');
        }
    }
    
    createGameOverEffect() {
        // 在蛇的位置创建爆炸效果
        this.snake.body.forEach((segment, index) => {
            setTimeout(() => {
                const x = segment.x * this.cellSize + this.cellSize / 2;
                const y = segment.y * this.cellSize + this.cellSize / 2;
                
                for (let i = 0; i < 10; i++) {
                    const angle = (Math.PI * 2 * i) / 10;
                    const speed = 1 + Math.random() * 2;
                    
                    this.particles.push({
                        x: x,
                        y: y,
                        vx: Math.cos(angle) * speed,
                        vy: Math.sin(angle) * speed,
                        life: 1,
                        decay: 0.015,
                        color: '#ff0000',
                        size: 2 + Math.random() * 2
                    });
                }
            }, index * 50);
        });
    }
    
    updateUI() {
        // 更新分数显示
        const scoreElement = document.getElementById('currentScore');
        if (scoreElement) scoreElement.textContent = this.gameState.score;
        
        const highScoreElement = document.getElementById('highScore');
        if (highScoreElement) highScoreElement.textContent = this.gameState.highScore;
        
        // 更新统计信息
        const levelElement = document.getElementById('level');
        if (levelElement) levelElement.textContent = this.gameState.level;
        
        const timeElement = document.getElementById('time');
        if (timeElement) {
            const minutes = Math.floor(this.gameState.elapsedTime / 60);
            const seconds = this.gameState.elapsedTime % 60;
            timeElement.textContent = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
        }
        
        const lengthElement = document.getElementById('length');
        if (lengthElement) lengthElement.textContent = this.snake.body.length;
        
        const speedElement = document.getElementById('speed');
        if (speedElement) {
            const speedLevel = Math.floor((150 - this.gameSpeed) / 10) + 1;
            speedElement.textContent = speedLevel;
        }
        
        const statusElement = document.getElementById('status');
        if (statusElement) {
            if (!this.gameState.isRunning) {
                statusElement.textContent = '停止';
                statusElement.style.color = '#ff0000';
            } else if (this.gameState.isPaused) {
                statusElement.textContent = '暂停';
                statusElement.style.color = '#ffff00';
            } else {
                statusElement.textContent = '运行中';
                statusElement.style.color = '#00ff9f';
            }
        }
    }
    
    render() {
        // 清空画布
        this.ctx.fillStyle = '#0a0a0f';
        this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        
        // 绘制网格背景
        this.drawGrid();
        
        // 绘制尾迹效果
        this.drawTrailEffects();
        
        // 绘制食物
        this.drawFood();
        
        // 绘制蛇
        this.drawSnake();
        
        // 绘制粒子
        this.drawParticles();
        
        // 更新迷你地图
        this.renderMiniMap();
    }
    
    drawGrid() {
        this.ctx.strokeStyle = 'rgba(42, 42, 58, 0.3)';
        this.ctx.lineWidth = 0.5;
        
        // 垂直线
        for (let x = 0; x <= this.gridSize; x++) {
            this.ctx.beginPath();
            this.ctx.moveTo(x * this.cellSize, 0);
            this.ctx.lineTo(x * this.cellSize, this.canvas.height);
            this.ctx.stroke();
        }
        
        // 水平线
        for (let y = 0; y <= this.gridSize; y++) {
            this.ctx.beginPath();
            this.ctx.moveTo(0, y * this.cellSize);
            this.ctx.lineTo(this.canvas.width, y * this.cellSize);
            this.ctx.stroke();
        }
    }
    
    drawSnake() {
        this.snake.body.forEach((segment, index) => {
            const x = segment.x * this.cellSize;
            const y = segment.y * this.cellSize;
            
            // 蛇头
            if (index === 0) {
                this.drawSnakeHead(x, y);
            } else {
                // 蛇身
                this.drawSnakeBody(x, y, index);
            }
        });
    }
    
    drawSnakeHead(x, y) {
        // 蛇头外框
        this.ctx.strokeStyle = this.snake.color;
        this.ctx.lineWidth = 2;
        this.ctx.shadowColor = this.snake.color;
        this.ctx.shadowBlur = 10;
        
        // 绘制蛇头
        this.ctx.fillStyle = '#0a0a0f';
        this.ctx.fillRect(x + 2, y + 2, this.cellSize - 4, this.cellSize - 4);
        this.ctx.strokeRect(x + 2, y + 2, this.cellSize - 4, this.cellSize - 4);
        
        // 蛇头内部
        this.ctx.fillStyle = this.snake.color;
        this.ctx.fillRect(x + 5, y + 5, this.cellSize - 10, this.cellSize - 10);
        
        // 蛇眼睛
        this.ctx.fillStyle = '#0a0a0f';
        const eyeSize = 3;
        
        // 根据方向确定眼睛位置
        let eye1X, eye1Y, eye2X, eye2Y;
        
        if (this.snake.direction.x === 1) { // 向右
            eye1X = x + this.cellSize - 8;
            eye1Y = y + 5;
            eye2X = x + this.cellSize - 8;
            eye2Y = y + this.cellSize - 8;
        } else if (this.snake.direction.x === -1) { // 向左
            eye1X = x + 5;
            eye1Y = y + 5;
            eye2X = x + 5;
            eye2Y = y + this.cellSize - 8;
        } else if (this.snake.direction.y === 1) { // 向下
            eye1X = x + 5;
            eye1Y = y + this.cellSize - 8;
            eye2X = x + this.cellSize - 8;
            eye2Y = y + this.cellSize - 8;
        } else { // 向上
            eye1X = x + 5;
            eye1Y = y + 5;
            eye2X = x + this.cellSize - 8;
            eye2Y = y + 5;
        }
        
        this.ctx.fillRect(eye1X, eye1Y, eyeSize, eyeSize);
        this.ctx.fillRect(eye2X, eye2Y, eyeSize, eyeSize);
        
        this.ctx.shadowBlur = 0;
    }
    
    drawSnakeBody(x, y, index) {
        // 蛇身渐变效果
        const alpha = 1 - (index / this.snake.body.length) * 0.5;
        
        this.ctx.fillStyle = `rgba(0, 255, 159, ${alpha * 0.8})`;
        this.ctx.fillRect(x + 3, y + 3, this.cellSize - 6, this.cellSize - 6);
        
        // 蛇身边框
        this.ctx.strokeStyle = `rgba(0, 255, 159, ${alpha})`;
        this.ctx.lineWidth = 1;
        this.ctx.strokeRect(x + 3, y + 3, this.cellSize - 6, this.cellSize - 6);
    }
    
    drawFood() {
        const x = this.food.position.x * this.cellSize;
        const y = this.food.position.y * this.cellSize;
        
        // 食物发光效果
        this.ctx.shadowColor = this.food.color;
        this.ctx.shadowBlur = 15;
        
        // 食物外框
        this.ctx.strokeStyle = this.food.color;
        this.ctx.lineWidth = 2;
        this.ctx.strokeRect(x + 3, y + 3, this.cellSize - 6, this.cellSize - 6);
        
        // 食物内部
        this.ctx.fillStyle = this.food.color;
        this.ctx.fillRect(x + 6, y + 6, this.cellSize - 12, this.cellSize - 12);
        
        // 食物动画效果
        const time = Date.now() - this.food.spawnTime;
        const scale = 1 + Math.sin(time * 0.005) * 0.1;
        
        this.ctx.save();
        this.ctx.translate(x + this.cellSize / 2, y + this.cellSize / 2);
        this.ctx.scale(scale, scale);
        
        // 绘制食物内部图案
        this.ctx.fillStyle = '#0a0a0f';
        this.ctx.fillRect(-2, -2, 4, 4);
        
        this.ctx.restore();
        this.ctx.shadowBlur = 0;
    }
    
    drawTrailEffects() {
        this.trailEffects.forEach(trail => {
            const alpha = trail.life * 0.3;
            this.ctx.fillStyle = `rgba(0, 255, 159, ${alpha})`;
            this.ctx.beginPath();
            this.ctx.arc(trail.x, trail.y, 3 * trail.life, 0, Math.PI * 2);
            this.ctx.fill();
        });
    }
    
    drawParticles() {
        this.particles.forEach(particle => {
            const alpha = particle.life;
            this.ctx.fillStyle = particle.color.replace(')', `, ${alpha})`).replace('rgb', 'rgba');
            this.ctx.beginPath();
            this.ctx.arc(particle.x, particle.y, particle.size * alpha, 0, Math.PI * 2);
            this.ctx.fill();
        });
    }
    
    renderMiniMap() {
        // 清空迷你地图
        this.miniCtx.fillStyle = '#0a0a0f';
        this.miniCtx.fillRect(0, 0, this.miniCanvas.width, this.miniCanvas.height);
        
        // 绘制蛇
        this.snake.body.forEach((segment, index) => {
            const x = segment.x * this.miniScale;
            const y = segment.y * this.miniScale;
            
            if (index === 0) {
                this.miniCtx.fillStyle = '#00ff9f';
            } else {
                this.miniCtx.fillStyle = `rgba(0, 255, 159, ${1 - index / this.snake.body.length * 0.5})`;
            }
            
            this.miniCtx.fillRect(x, y, this.miniScale, this.miniScale);
        });
        
        // 绘制食物
        const foodX = this.food.position.x * this.miniScale;
        const foodY = this.food.position.y * this.miniScale;
        this.miniCtx.fillStyle = this.food.color;
        this.miniCtx.fillRect(foodX, foodY, this.miniScale, this.miniScale);
    }
    
    startTimer() {
        this.timerInterval = setInterval(() => {
            if (this.gameState.isRunning && !this.gameState.isPaused) {
                this.gameState.elapsedTime++;
                this.updateUI();
            }
        }, 1000);
    }
    
    stopTimer() {
        if (this.timerInterval) {
            clearInterval(this.timerInterval);
            this.timerInterval = null;
        }
    }
    
    updateHighScore() {
        if (this.gameState.score > this.gameState.highScore) {
            this.gameState.highScore = this.gameState.score;
            this.saveHighScore();
        }
    }
    
    loadHighScore() {
        const saved = localStorage.getItem('neonSnakeHighScore');
        if (saved) {
            this.gameState.highScore = parseInt(saved) || 0;
        }
    }
    
    saveHighScore() {
        localStorage.setItem('neonSnakeHighScore', this.gameState.highScore.toString());
    }
    
    handleResize() {
        // 响应窗口大小改变
        this.render();
    }
}

// 初始化游戏
document.addEventListener('DOMContentLoaded', () => {
    const game = new NeonSnakeGame();
    
    // 添加触摸事件支持
    let touchStartX = 0;
    let touchStartY = 0;
    
    document.addEventListener('touchstart', (e) => {
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
    }, { passive: true });
    
    document.addEventListener('touchend', (e) => {
        const touchEndX = e.changedTouches[0].clientX;
        const touchEndY = e.changedTouches[0].clientY;
        
        const deltaX = touchEndX - touchStartX;
        const deltaY = touchEndY - touchStartY;
        
        // 判断滑动方向
        if (Math.abs(deltaX) > Math.abs(deltaY)) {
            // 水平滑动
            if (deltaX > 30) {
                game.changeDirection('right');
            } else if (deltaX < -30) {
                game.changeDirection('left');
            }
        } else {
            // 垂直滑动
            if (deltaY > 30) {
                game.changeDirection('down');
            } else if (deltaY < -30) {
                game.changeDirection('up');
            }
        }
    }, { passive: true });
    
    // 开始按钮
    document.getElementById('startBtn')?.addEventListener('click', () => {
        game.startGame();
    });
    
    console.log('霓虹蛇游戏已加载');
});