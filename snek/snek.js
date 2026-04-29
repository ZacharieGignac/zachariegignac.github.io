/**
 * Snek - Animated Snake Background
 * A lightweight, customizable snake game background for your web pages
 */

class SnekBackground {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: true });
    
    // Default options
    this.options = {
      snakeCount: 10,
      cellSize: 22,
      tickMs: 115,
      colors: [
        '103, 203, 255',  // Cyan
        '93, 240, 206',   // Mint
        '170, 152, 255',  // Purple
        '255, 180, 100',  // Orange
        '255, 100, 150',  // Pink
        '255, 230, 109',  // Yellow
        '100, 255, 150',  // Green
        '255, 120, 120',  // Red
        '150, 200, 255',  // Light Blue
        '200, 150, 255'   // Lavender
      ],
      ...options
    };

    this.directions = [
      { x: 1, y: 0 },
      { x: -1, y: 0 },
      { x: 0, y: 1 },
      { x: 0, y: -1 }
    ];

    this.state = {
      dpr: Math.max(1, Math.min(window.devicePixelRatio || 1, 2)),
      cell: this.options.cellSize,
      cols: 0,
      rows: 0,
      snakes: [],
      foods: [],
      snakeCount: this.options.snakeCount,
      tickMs: this.options.tickMs,
      lastTick: 0
    };

    this.animationId = null;
    this.init();
  }

  init() {
    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.start();
  }

  resize() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.state.dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));
    this.canvas.width = Math.floor(width * this.state.dpr);
    this.canvas.height = Math.floor(height * this.state.dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.ctx.setTransform(this.state.dpr, 0, 0, this.state.dpr, 0, 0);

    this.state.cols = Math.max(16, Math.floor(width / this.state.cell));
    this.state.rows = Math.max(12, Math.floor(height / this.state.cell));

    if (this.state.snakes.length === 0) {
      this.resetSnakes();
    }
  }

  createSnake(seedX, seedY, dir, color) {
    const snake = {
      parts: [],
      dir,
      maxLength: 12,
      color
    };

    for (let i = 0; i < 8; i += 1) {
      snake.parts.push({ x: (seedX - i + this.state.cols) % this.state.cols, y: seedY });
    }

    return snake;
  }

  resetSnakes() {
    const yPositions = [];
    for (let i = 0; i < this.state.snakeCount; i++) {
      yPositions.push(Math.floor(this.state.rows * (0.25 + (i * 0.5) / this.state.snakeCount)));
    }
    const x = Math.floor(this.state.cols * 0.28);

    this.state.snakes = yPositions.map((y, index) => {
      const color = this.options.colors[index % this.options.colors.length];
      return this.createSnake(x + index * 6, y, { x: 1, y: 0 }, color);
    });

    this.state.foods = this.state.snakes.map((_, index) => this.placeFood(index));
  }

  placeFood(snakeIndex) {
    const occupiedParts = this.state.snakes.flatMap((snake) => snake.parts);

    for (let i = 0; i < 90; i += 1) {
      const candidate = {
        x: Math.floor(Math.random() * this.state.cols),
        y: Math.floor(Math.random() * this.state.rows)
      };
      const occupied = occupiedParts.some((part) => part.x === candidate.x && part.y === candidate.y);
      if (!occupied) {
        return candidate;
      }
    }

    return {
      x: Math.floor(this.state.cols / 2),
      y: Math.floor((this.state.rows / (this.state.snakeCount + 1)) * (snakeIndex + 1))
    };
  }

  isReverse(currentDir, nextDir) {
    return nextDir.x === -currentDir.x && nextDir.y === -currentDir.y;
  }

  scoreDirection(snake, food, nextDir) {
    const head = snake.parts[0];
    const nx = (head.x + nextDir.x + this.state.cols) % this.state.cols;
    const ny = (head.y + nextDir.y + this.state.rows) % this.state.rows;

    const allBodies = this.state.snakes.flatMap((item) => item.parts);
    const willHit = allBodies.some((part) => part.x === nx && part.y === ny);
    const distance = Math.abs(nx - food.x) + Math.abs(ny - food.y);
    return distance + (willHit ? 999 : 0) + Math.random() * 0.6;
  }

  chooseDirection(snake, food) {
    const options = this.directions.filter((nextDir) => !this.isReverse(snake.dir, nextDir));
    options.sort((a, b) => this.scoreDirection(snake, food, a) - this.scoreDirection(snake, food, b));
    snake.dir = options[0] || snake.dir;
  }

  updateSnakes() {
    this.state.snakes.forEach((snake, index) => {
      const food = this.state.foods[index];
      this.chooseDirection(snake, food);

      const head = snake.parts[0];
      const nextHead = {
        x: (head.x + snake.dir.x + this.state.cols) % this.state.cols,
        y: (head.y + snake.dir.y + this.state.rows) % this.state.rows
      };

      const allBodies = this.state.snakes.flatMap((item, itemIndex) => {
        if (itemIndex === index) {
          return item.parts.slice(0, -1);
        }
        return item.parts;
      });
      const collision = allBodies.some((part) => part.x === nextHead.x && part.y === nextHead.y);

      if (collision) {
        const seedX = Math.floor(this.state.cols * (0.2 + index * 0.2));
        const seedY = Math.floor(this.state.rows * (0.25 + index * 0.22));
        this.state.snakes[index] = this.createSnake(seedX, seedY, { x: 1, y: 0 }, snake.color);
        this.state.foods[index] = this.placeFood(index);
        return;
      }

      snake.parts.unshift(nextHead);

      const ateFood = nextHead.x === food.x && nextHead.y === food.y;
      if (ateFood) {
        snake.maxLength = Math.min(24, snake.maxLength + 1);
        this.state.foods[index] = this.placeFood(index);
      }

      while (snake.parts.length > snake.maxLength) {
        snake.parts.pop();
      }
    });
  }

  drawSnakes() {
    const width = this.canvas.width / this.state.dpr;
    const height = this.canvas.height / this.state.dpr;
    this.ctx.clearRect(0, 0, width, height);

    const foodSize = this.state.cell * 0.34;
    this.state.foods.forEach((food, index) => {
      const color = this.state.snakes[index]?.color || '103, 203, 255';
      this.ctx.fillStyle = `rgba(${color}, 1)`;
      this.ctx.fillRect(
        food.x * this.state.cell + (this.state.cell - foodSize) / 2,
        food.y * this.state.cell + (this.state.cell - foodSize) / 2,
        foodSize,
        foodSize
      );
    });

    this.state.snakes.forEach((snake) => {
      snake.parts.forEach((part, index) => {
        const t = 1 - index / snake.parts.length;
        const size = this.state.cell * (0.44 + t * 0.42);
        const offset = (this.state.cell - size) / 2;
        this.ctx.fillStyle = `rgba(${snake.color}, ${0.5 + t * 0.5})`;
        this.ctx.fillRect(part.x * this.state.cell + offset, part.y * this.state.cell + offset, size, size);
      });
    });
  }

  frame(time) {
    if (!this.state.lastTick) {
      this.state.lastTick = time;
    }

    if (time - this.state.lastTick >= this.state.tickMs) {
      this.state.lastTick = time;
      this.updateSnakes();
    }

    this.drawSnakes();
    this.animationId = window.requestAnimationFrame((t) => this.frame(t));
  }

  start() {
    if (!this.animationId) {
      this.animationId = window.requestAnimationFrame((t) => this.frame(t));
    }
  }

  stop() {
    if (this.animationId) {
      window.cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
  }

  destroy() {
    this.stop();
    window.removeEventListener('resize', () => this.resize());
  }
}

// Auto-initialize if data-snek attribute is present
document.addEventListener('DOMContentLoaded', () => {
  const canvas = document.querySelector('[data-snek]');
  if (canvas) {
    const options = {};
    if (canvas.dataset.snekColors) {
      options.colors = canvas.dataset.snekColors.split(';').map(c => c.trim());
    }
    if (canvas.dataset.snekCount) {
      options.snakeCount = parseInt(canvas.dataset.snekCount);
    }
    if (canvas.dataset.snekSpeed) {
      options.tickMs = parseInt(canvas.dataset.snekSpeed);
    }
    if (canvas.dataset.snekCellSize) {
      options.cellSize = parseInt(canvas.dataset.snekCellSize);
    }
    new SnekBackground(canvas, options);
  }
});
