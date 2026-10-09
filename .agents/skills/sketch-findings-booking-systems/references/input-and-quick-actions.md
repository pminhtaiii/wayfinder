# Input & Quick Actions

## Design Decisions

**Modern Chat Bar Pill Container** — The search input bar is styled as a unified pill-shaped bar (`border-radius: 9999px`) with a light background (`#fafafc`) and thin border. This aligns with modern ChatGPT-like layouts. When focused, the border transitions to purple and is surrounded by a soft outer glow.

**Inline Circle Send Button** — The send button sits inside the right edge of the pill input container. It is a perfect circle, featuring a paper plane icon with a drop shadow, which slightly scales up on hover.

**Quick Action Chips with Hover Dynamics** — Pill-shaped chips below the input card act as short-cuts (e.g. "Find flights to Tokyo"). They feature subtle hover effects: translating upwards and scaling up by 3% (`transform: translateY(-1px) scale(1.03)`) to feel tactile and responsive.

## CSS Patterns

```css
/* Input container pill */
.chat-input-wrapper {
  display: flex;
  gap: 8px;
  align-items: center;
  border: 1px solid #DCE2EE;
  border-radius: 9999px; /* Pill layout */
  padding: 4px 6px 4px 18px;
  background: #fafafc;
  transition: all 0.2s;
}

/* Active focus ring */
.chat-input-wrapper:focus-within {
  border-color: var(--color-primary);
  box-shadow: 0 0 0 3px rgba(124, 92, 252, 0.15);
  background: white;
}

/* Chat text input */
.chat-input {
  flex: 1;
  border: none;
  background: transparent;
  padding: 8px 0;
  height: 36px;
  font-size: var(--text-sm);
  outline: none;
  resize: none;
}

/* Circular send button */
.chat-send {
  width: 36px;
  height: 36px;
  border-radius: 50%; /* Circle shape */
  background: var(--color-primary);
  color: white;
  border: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 2px 8px rgba(124, 92, 252, 0.2);
  transition: all 0.2s;
}
.chat-send:hover {
  transform: scale(1.05);
  background: var(--color-primary-hover);
}

/* Tactile quick action chips */
.quick-action {
  background: white;
  border: 1px solid #ECEFF5;
  color: var(--color-text-secondary);
  border-radius: 9999px;
  padding: 6px 14px;
  font-size: var(--text-xs);
  cursor: pointer;
  box-shadow: 0 2px 4px rgba(0,0,0,0.02);
  transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
}
.quick-action:hover {
  transform: translateY(-1px) scale(1.03);
  border-color: var(--color-primary);
  box-shadow: 0 4px 10px rgba(124, 92, 252, 0.08);
}
```

## HTML Structure

```html
<!-- Input area inside chat card -->
<div class="chat-input-area">
  <div class="quick-actions">
    <button class="quick-action">Find flights to Tokyo</button>
  </div>
  <div class="chat-input-wrapper">
    <textarea class="chat-input" placeholder="Ask anything..."></textarea>
    <button class="chat-send">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
    </button>
  </div>
</div>
```

## What to Avoid

- **Send button outside input bounds** — looks boxy and disjointed.
- **Flat buttons with harsh borders** — does not fit the soft, modern card aesthetic.
- **Harsh transitions on hover** — ensure hover scales have easing and transition durations of ~0.2s.

## Origin
Synthesized from sketches: 001, 002
Source files available in: sources/001-chatbot-search-transition/
