# Chatbot Layout & Flow

## Design Decisions

**Chatbot-First Centered Start** — When the application first loads, the chatbot UI sits perfectly centered in the middle of the screen (max-width `680px`, `margin: 0 auto;`). This provides a clean, focused conversational landing zone for the user before any search details are fetched.

**Split View Slide Transition** — Upon initiating a flight search, the screen smoothly transitions into a split view. The chatbot slides to the left panel (taking up ~35-38% of the width) while the flight search results panel opens and expands on the right (~62-65% width). 

**Spring-like Smooth Layout Transitions** — Use GPU-accelerated CSS flex/width transitions combined with opacity fades and scale transforms to avoid layout jumps:
*   Transition parameter: `all 0.75s cubic-bezier(0.19, 1, 0.22, 1)`
*   `will-change` properties: `width, max-width, transform, border-radius`
*   Initial results-area spacing: `flex: 0 0 0%; overflow: hidden; width: 0%;` to ensure it occupies no space and allows the chat card to center.
*   Transition results-area spacing: `flex: 1; width: 62%; overflow-y: auto;` to slide results in and enable scrolling.

## CSS Patterns

```css
/* Split container workspace */
.main-workspace {
  display: flex;
  padding: 16px;
  background-color: var(--color-bg);
  perspective: 1000px; /* Enables 3D acceleration for smooth transitions */
}

/* Chat card wrapper - starts centered */
.chat-card {
  width: 100%;
  max-width: 680px;
  margin: 0 auto;
  border: 1px solid rgba(0,0,0,0.06);
  border-radius: 24px;
  box-shadow: 0 10px 40px -10px rgba(124, 92, 252, 0.08);
  transition: all 0.75s cubic-bezier(0.19, 1, 0.22, 1);
  will-change: width, max-width, transform, border-radius;
}

/* Active split state */
.split-active .chat-card {
  width: 38%;
  max-width: 420px;
  margin: 0;
  border-radius: 20px;
}

/* Results panel - hidden initially */
.results-area {
  display: flex;
  visibility: hidden;
  opacity: 0;
  transform: translateX(40px) scale(0.98);
  transition: all 0.85s cubic-bezier(0.19, 1, 0.22, 1);
  width: 0%;
  flex: 0 0 0%;
  overflow: hidden;
  padding-left: 0;
}

/* Active results panel */
.split-active .results-area {
  visibility: visible;
  opacity: 1;
  transform: translateX(0) scale(1);
  width: 62%;
  flex: 1;
  padding-left: 24px;
  overflow-y: auto; /* Enable scroll when cards overflow */
}
```

## HTML Structure

```
main-workspace (flex row)
├── chat-card (starts centered, slides left)
│   ├── chat-messages (scrollable)
│   └── chat-input-area
└── results-area (hidden initially, slides open right)
    ├── results-header
    └── chat-flight-card (repeated cards)
```

## What to Avoid

- **Instant layout switches without transitions** — disorients users when search results load.
- **Letting hidden elements occupy flex space** — causes the centered chat box to be pushed off-center before search occurs. Always set `flex: 0 0 0%` or `display: none` on hidden siblings.
- **Fixed heights on flight cards when results overflow** — results will squish and clip buttons/pricing. Ensure results container has `overflow-y: auto` and cards have `flex-shrink: 0`.

## Origin
Synthesized from sketches: 001, 002
Source files available in: sources/001-chatbot-search-transition/
