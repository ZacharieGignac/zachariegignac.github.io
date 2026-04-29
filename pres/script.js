// Slide Management
let currentSlide = 1;
const totalSlides = document.querySelectorAll('.slide').length;

// Custom slide order - intersperse demos throughout presentation
// Physical slide numbers: [Hero, VFS, Demo:Menu, LiveSync, Demo:AI, IntelliSense, CodeAccel, Demo:Stub, Demo:Help, Debug, Demo:Console, Fleet, Demo:Settings, Safety, QuickStart, Final]
const slideOrder = [1, 2, 11, 3, 10, 4, 5, 13, 15, 6, 14, 7, 12, 8, 9, 16];
let currentIndex = 0; // Index in slideOrder array

// Initialize
function init() {
    createSlideIndicators();
    showSlide(slideOrder[currentIndex]);
    attachEventListeners();
    initInteractiveElements();
    console.log('%c🚀 RoomOS Macros Presentation Loaded!', 'color: #0098FF; font-size: 20px; font-weight: bold;');
}

// Create slide indicators (dots)
function createSlideIndicators() {
    const indicatorsContainer = document.getElementById('slideIndicators');
    for (let i = 0; i < slideOrder.length; i++) {
        const dot = document.createElement('div');
        dot.className = 'slide-dot';
        dot.dataset.index = i;
        dot.addEventListener('click', () => goToSlideIndex(i));
        indicatorsContainer.appendChild(dot);
    }
}

// Show specific slide by its physical slide number
function showSlide(n) {
    const slides = document.querySelectorAll('.slide');
    const dots = document.querySelectorAll('.slide-dot');
    
    // Update current slide
    if (n > totalSlides) n = totalSlides;
    if (n < 1) n = 1;
    currentSlide = n;
    
    // Find index in slideOrder
    currentIndex = slideOrder.indexOf(n);
    if (currentIndex === -1) currentIndex = 0;
    
    // Remove all active classes
    slides.forEach(slide => {
        slide.classList.remove('active', 'prev', 'next');
    });
    dots.forEach(dot => {
        dot.classList.remove('active');
    });
    
    // Set current slide
    const currentSlideEl = slides[currentSlide - 1];
    currentSlideEl.classList.add('active');
    dots[currentIndex].classList.add('active');
    
    // Set prev/next for transition
    if (currentIndex > 0) {
        const prevSlideNum = slideOrder[currentIndex - 1];
        slides[prevSlideNum - 1].classList.add('prev');
    }
    if (currentIndex < slideOrder.length - 1) {
        const nextSlideNum = slideOrder[currentIndex + 1];
        slides[nextSlideNum - 1].classList.add('next');
    }
    
    // Update counter
    document.getElementById('slideCounter').textContent = `${currentIndex + 1} / ${slideOrder.length}`;
    
    // Update navigation buttons
    document.getElementById('prevBtn').disabled = currentIndex === 0;
    document.getElementById('nextBtn').disabled = currentIndex === slideOrder.length - 1;
    
    // Trigger slide-specific animations
    triggerSlideAnimations(currentSlide);
}

// Navigate slides
function nextSlide() {
    if (currentIndex < slideOrder.length - 1) {
        currentIndex++;
        showSlide(slideOrder[currentIndex]);
    }
}

function prevSlide() {
    if (currentIndex > 0) {
        currentIndex--;
        showSlide(slideOrder[currentIndex]);
    }
}

function goToSlide(n) {
    showSlide(n);
}

function goToSlideIndex(index) {
    if (index >= 0 && index < slideOrder.length) {
        currentIndex = index;
        showSlide(slideOrder[currentIndex]);
    }
}

// Attach event listeners
function attachEventListeners() {
    // Navigation buttons
    document.getElementById('prevBtn').addEventListener('click', prevSlide);
    document.getElementById('nextBtn').addEventListener('click', nextSlide);
    
    // Keyboard navigation
    document.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowRight' || e.key === ' ') {
            e.preventDefault();
            nextSlide();
        } else if (e.key === 'ArrowLeft') {
            e.preventDefault();
            prevSlide();
        } else if (e.key >= '1' && e.key <= '9') {
            const slideIndex = parseInt(e.key) - 1;
            if (slideIndex < slideOrder.length) {
                goToSlideIndex(slideIndex);
            }
        } else if (e.key === 'Home') {
            goToSlideIndex(0);
        } else if (e.key === 'End') {
            goToSlideIndex(slideOrder.length - 1);
        }
    });
    
    // Touch/swipe support
    let touchStartX = 0;
    let touchEndX = 0;
    
    document.addEventListener('touchstart', (e) => {
        touchStartX = e.changedTouches[0].screenX;
    });
    
    document.addEventListener('touchend', (e) => {
        touchEndX = e.changedTouches[0].screenX;
        handleSwipe();
    });
    
    function handleSwipe() {
        if (touchEndX < touchStartX - 50) {
            nextSlide();
        }
        if (touchEndX > touchStartX + 50) {
            prevSlide();
        }
    }
}

// Initialize interactive elements
function initInteractiveElements() {
    // Workflow stages (Slide 3 - Live Sync)
    const workflowStages = document.querySelectorAll('.workflow-stage');
    workflowStages.forEach((stage, index) => {
        stage.addEventListener('click', () => {
            // Remove active from all
            workflowStages.forEach(s => s.classList.remove('active-stage'));
            
            // Animate sequence
            let delay = 0;
            for (let i = 0; i <= index; i++) {
                setTimeout(() => {
                    workflowStages[i].classList.add('active-stage');
                    setTimeout(() => {
                        workflowStages[i].classList.remove('active-stage');
                    }, 600);
                }, delay);
                delay += 300;
            }
        });
    });
    
    // xAPI categories hover effects (Slide 4 - IntelliSense xAPI)
    const xapiCategories = document.querySelectorAll('.xapi-category');
    xapiCategories.forEach(category => {
        category.addEventListener('mouseenter', () => {
            const icon = category.querySelector('.category-icon');
            icon.style.transform = 'scale(1.2) rotate(10deg)';
            icon.style.transition = 'transform 0.3s ease';
        });
        
        category.addEventListener('mouseleave', () => {
            const icon = category.querySelector('.category-icon');
            icon.style.transform = 'scale(1) rotate(0deg)';
        });
    });
    
    // Form inputs focus effects (Slide 7 - Fleet Management)
    const formInputs = document.querySelectorAll('.form-input');
    formInputs.forEach(input => {
        input.addEventListener('focus', () => {
            input.parentElement.style.transform = 'translateX(5px)';
            input.parentElement.style.transition = 'transform 0.3s ease';
        });
        
        input.addEventListener('blur', () => {
            input.parentElement.style.transform = 'translateX(0)';
        });
    });
    
    // Profile items (Slide 7 - Fleet Management)
    const profileItems = document.querySelectorAll('.profile-item');
    profileItems.forEach(item => {
        item.addEventListener('click', () => {
            profileItems.forEach(p => p.classList.remove('active'));
            item.classList.add('active');
        });
    });
}

// Trigger slide-specific animations
function triggerSlideAnimations(slideNumber) {
    const slide = document.querySelector(`.slide[data-slide="${slideNumber}"]`);
    if (!slide) return;
    
    // Reset animations by removing and re-adding animate classes
    const animatedElements = slide.querySelectorAll('.animate-in');
    animatedElements.forEach(el => {
        el.style.animation = 'none';
        setTimeout(() => {
            el.style.animation = '';
        }, 10);
    });
    
    // Slide-specific triggers
    switch (slideNumber) {
        case 2: // Virtual File System
            animateFileTree();
            animateDataFlow();
            break;
        case 3: // Live Sync
            animateWorkflow();
            break;
        case 4: // IntelliSense xAPI
            animateXapiCategories();
            break;
        case 5: // Code Acceleration
            animateCodeDemo();
            break;
        case 6: // Real-time Debugging
            animateLogs();
            break;
        case 7: // Fleet Management
            animateProfiles();
            break;
        case 8: // Reliability & Safety
            animateSafetyCards();
            break;
        case 9: // Quick Start
            animateTimeline();
            break;
        case 10: // AI-Assisted Coding (demo)
        case 11: // Context Menu (demo)
        case 12: // Extension Settings (demo)
        case 13: // Insert xAPI Stub (demo)
        case 14: // Macro Console Output (demo)
        case 15: // Show xAPI Help (demo)
            animateGifSlide();
            break;
        case 16: // Final
            animateFinalSlide();
            break;
    }
}

// Animation functions for specific slides
function animateFileTree() {
    const treeItems = document.querySelectorAll('.tree-item');
    treeItems.forEach((item, index) => {
        item.style.animation = 'none';
        setTimeout(() => {
            item.style.animation = '';
        }, index * 100);
    });
}

function animateDataFlow() {
    const particles = document.querySelectorAll('.particle');
    particles.forEach((particle, index) => {
        particle.style.animation = 'none';
        setTimeout(() => {
            particle.style.animation = '';
        }, index * 300);
    });
}

function animateWorkflow() {
    const stages = document.querySelectorAll('.workflow-stage');
    stages.forEach((stage, index) => {
        setTimeout(() => {
            stage.style.transform = 'translateY(-10px)';
            stage.style.transition = 'transform 0.5s ease';
            setTimeout(() => {
                stage.style.transform = '';
            }, 500);
        }, index * 200);
    });
}

function animateXapiCategories() {
    const categories = document.querySelectorAll('.xapi-category');
    categories.forEach((cat, index) => {
        cat.style.animation = 'none';
        setTimeout(() => {
            cat.style.animation = '';
        }, index * 150);
    });
}

function animateCodeDemo() {
    const contextMenu = document.querySelector('.context-menu');
    if (contextMenu) {
        setTimeout(() => {
            contextMenu.style.animation = 'menuPop 0.5s ease';
        }, 500);
    }
    
    const tooltip = document.querySelector('.smart-tooltip');
    if (tooltip) {
        setTimeout(() => {
            tooltip.style.animation = 'tooltipSlide 0.6s ease';
        }, 800);
    }
}

function animateLogs() {
    const logEntries = document.querySelectorAll('.log-entry');
    logEntries.forEach((entry, index) => {
        entry.style.opacity = '0';
        setTimeout(() => {
            entry.style.opacity = '1';
            entry.style.transition = 'opacity 0.3s ease';
        }, index * 200);
    });
}

function animateProfiles() {
    const profileItems = document.querySelectorAll('.profile-item');
    profileItems.forEach((item, index) => {
        setTimeout(() => {
            item.style.transform = 'translateX(-10px)';
            item.style.transition = 'transform 0.3s ease';
            setTimeout(() => {
                item.style.transform = '';
            }, 300);
        }, index * 200);
    });
}

function animateSafetyCards() {
    const cards = document.querySelectorAll('.safety-card');
    cards.forEach((card, index) => {
        card.style.animation = 'none';
        setTimeout(() => {
            card.style.animation = '';
        }, index * 200);
    });
}

function animateTimeline() {
    const steps = document.querySelectorAll('.timeline-step');
    steps.forEach((step, index) => {
        step.style.animation = 'none';
        setTimeout(() => {
            step.style.animation = '';
        }, index * 300);
    });
}

function animateGifSlide() {
    const gif = document.querySelector('.slide.active .demo-gif');
    if (gif) {
        gif.style.animation = 'none';
        setTimeout(() => {
            gif.style.animation = 'fadeInScale 0.8s ease forwards';
        }, 100);
    }
}

function animateFinalSlide() {
    const formula = document.querySelector('.final-formula');
    if (formula) {
        formula.style.opacity = '0';
        formula.style.transform = 'scale(0.9)';
        setTimeout(() => {
            formula.style.opacity = '1';
            formula.style.transform = 'scale(1)';
            formula.style.transition = 'all 0.8s ease';
        }, 300);
    }
}

// Auto-play functionality (optional - commented out by default)
let autoPlayInterval = null;
function startAutoPlay(interval = 8000) {
    stopAutoPlay(); // Clear any existing interval
    autoPlayInterval = setInterval(() => {
        if (currentSlide < totalSlides) {
            nextSlide();
        } else {
            stopAutoPlay();
        }
    }, interval);
}

function stopAutoPlay() {
    if (autoPlayInterval) {
        clearInterval(autoPlayInterval);
        autoPlayInterval = null;
    }
}

// Stop auto-play on user interaction
document.addEventListener('keydown', stopAutoPlay);
document.addEventListener('click', stopAutoPlay);

// Fullscreen toggle (F11 hint)
function toggleFullscreen() {
    if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen();
    } else {
        if (document.exitFullscreen) {
            document.exitFullscreen();
        }
    }
}

// F key for fullscreen
document.addEventListener('keydown', (e) => {
    if (e.key === 'f' || e.key === 'F') {
        toggleFullscreen();
    }
});

// Presentation mode hint
console.log('%c💡 Keyboard Shortcuts:', 'color: #4EC9B0; font-size: 14px; font-weight: bold;');
console.log('%c→ / Space: Next slide', 'color: #CCCCCC; font-size: 12px;');
console.log('%c← : Previous slide', 'color: #CCCCCC; font-size: 12px;');
console.log('%c1-9: Jump to slide', 'color: #CCCCCC; font-size: 12px;');
console.log('%cHome: First slide', 'color: #CCCCCC; font-size: 12px;');
console.log('%cEnd: Last slide', 'color: #CCCCCC; font-size: 12px;');
console.log('%cF: Toggle fullscreen', 'color: #CCCCCC; font-size: 12px;');

// Initialize on load
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
