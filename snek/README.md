# 🐍 Snek Background

A lightweight, animated snake game background for your web pages. Perfect for adding subtle, engaging motion to landing pages, portfolios, or any web project.

## Features

- ✨ **Zero dependencies** - Pure vanilla JavaScript
- 🎨 **Fully customizable** - Colors, speed, number of snakes, cell size
- ♿ **Accessible** - Respects `prefers-reduced-motion`
- 📦 **Tiny footprint** - Minimal performance impact
- 🚀 **Easy to use** - Drop in and go with auto-initialization

## Quick Start

### 1. Include the files

```html
<link rel="stylesheet" href="snek.css">
<script src="snek.js"></script>
```

### 2. Add a canvas element

```html
<canvas data-snek aria-hidden="true"></canvas>
```

That's it! The snake background will automatically initialize with 10 colorful snakes.

## Customization

### Using Data Attributes

Customize the background directly in your HTML:

```html
<canvas data-snek
        data-snek-count="3"
        data-snek-colors="103, 203, 255; 93, 240, 206; 170, 152, 255"
        data-snek-speed="115"
        data-snek-cell-size="22"
        aria-hidden="true">
</canvas>
```

**Available attributes:**

- `data-snek-count` - Number of snakes (default: 10)
- `data-snek-colors` - Semicolon-separated RGB values (default: 10 vibrant colors)
- `data-snek-speed` - Update interval in milliseconds (default: 115)
- `data-snek-cell-size` - Size of grid cells in pixels (default: 22)

### Using JavaScript API

For more control, use the JavaScript API:

```html
<canvas id="my-snake-bg"></canvas>

<script>
  const canvas = document.getElementById('my-snake-bg');
  const snek = new SnekBackground(canvas, {
    snakeCount: 5,
    cellSize: 20,
    tickMs: 100,
    colors: [
      '103, 203, 255',  // Cyan
      '93, 240, 206',   // Mint
      '170, 152, 255',  // Purple
      '255, 180, 100',  // Orange
      '255, 100, 150'   // Pink
    ]
  });

  // Control the animation
  snek.stop();   // Pause
  snek.start();  // Resume
  snek.destroy(); // Clean up
</script>
```

## Styling

The default CSS positions the canvas as a fixed background:

```css
[data-snek] {
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: -1;
  opacity: 0.24;
  filter: blur(1.1px) saturate(1.1);
}
```

You can override these styles to fit your design:

```css
#my-snake-bg {
  opacity: 0.5;
  filter: blur(2px);
  /* or make it absolute for section backgrounds */
  position: absolute;
}
```

## Methods

When using the JavaScript API, you have access to these methods:

- `start()` - Start/resume the animation
- `stop()` - Pause the animation
- `resetSnakes()` - Reset all snakes to starting positions
- `destroy()` - Stop animation and clean up event listeners

## Browser Support

Works in all modern browsers that support:
- Canvas API
- ES6 Classes
- requestAnimationFrame

## Performance

The animation is optimized for performance:
- Uses `requestAnimationFrame` for smooth 60fps
- Respects device pixel ratio (capped at 2x)
- Minimal canvas redraws
- Automatically pauses for users with motion sensitivity

## License

MIT License - Feel free to use in personal and commercial projects

## Examples

Check out `example.html` for a complete working demo with all features.

---

Made with 🐍 by Zacharie Gignac
