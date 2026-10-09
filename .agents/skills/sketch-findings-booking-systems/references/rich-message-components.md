# Rich Message Components

## Design Decisions

**Flight Cards Render Inline** — Flight cards display key airline branding (rounded-square logos, flight numbers), times, routes, stops, match score badges, price details, and a primary CTA. 

**Two-Row Flight Route Card Layout** — Align times, airport codes, and travel duration horizontally in a clean two-row format:
*   **Times Row (Row 1):** Departure Time (left) and Arrival Time (right) separated by a clean horizontal route line containing a centered connections pill (e.g. "Non-stop" or "1 Stop").
*   **Details Row (Row 2):** Departure Airport (left), Travel Duration (center), and Arrival Airport (right) aligned in a straight horizontal line. This makes the flight path instantly readable and balanced.

**Modern ChatGPT-Style Chat Bubbles** — Upgraded conversational feed features:
*   **User Bubbles:** Sleek rounded corners (`18px 18px 2px 18px`), borderless layout, vibrant purple-to-blue gradient (`linear-gradient(135deg, #7C5CFC, #633BF7)`), and soft shadow.
*   **Agent Bubbles:** Soft cool-white background, light gray border (`1px solid #ECEFF5`), rounded corners (`18px 18px 18px 2px`), and subtle shadow.

**Match Score Pills** — Badges with score percentage and mini color-coded progress bars:
*   *Strong Match:* Green background (`#ECFDF5`), green text (`#009966`), bar fill (`#10B981`) for scores 80-100.
*   *Fair Match:* Blue background (`#EFF6FF`), blue text (`#2563EB`), bar fill (`#61A8FF`) for scores 60-79.
*   *Weak Match:* Orange background (`#FFF7ED`), orange text (`#EA580C`), bar fill (`#FF8904`) for scores <60.

## CSS Patterns

```css
/* Modern user message bubble */
.msg.user .bubble {
  background: linear-gradient(135deg, #7C5CFC, #633BF7);
  color: white;
  border-radius: 18px 18px 2px 18px;
  border: none;
  box-shadow: 0 4px 12px rgba(124, 92, 252, 0.15);
}

/* Modern agent message bubble */
.msg.agent .bubble {
  background: white;
  color: var(--color-text);
  border-radius: 18px 18px 18px 2px;
  border: 1px solid #ECEFF5;
  box-shadow: 0 2px 8px rgba(0,0,0,0.02);
}

/* Flight card layout */
.chat-flight-card {
  border: 1px solid #E7EBF4;
  border-radius: 16px;
  background: white;
  padding: 20px;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.015);
  position: relative;
  overflow: hidden;
  flex-shrink: 0; /* Prevent squishing */
}

/* Route layout - Vertical flex containing two rows */
.chat-flight-route {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 0;
}

/* Row 2 - Airport codes & duration aligned on a straight line */
.route-details-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  width: 100%;
  color: var(--color-text-secondary);
  font-size: var(--text-sm);
  font-weight: 600;
}
```

## HTML Structure

```html
<!-- Flight Card route section -->
<div class="chat-flight-route">
  <!-- Row 1: Times and Connection Line -->
  <div class="route-times-row" style="display: flex; justify-content: space-between; align-items: center; width: 100%;">
    <span class="route-time" style="font-size: var(--text-lg); font-weight: 700;">12:45</span>
    <div class="route-path-line" style="flex: 1; margin: 0 16px; position: relative; height: 2px; background: #D9E1F0;">
      <span class="path-stops" style="position: absolute; top: -11px; left: 50%; transform: translateX(-50%); font-size: 10px; font-weight: 600; background: #F1F4FA; border: 1px solid #E2E8F0; padding: 1px 8px; border-radius: 9999px;">Non-stop</span>
    </div>
    <span class="route-time" style="font-size: var(--text-lg); font-weight: 700;">16:00</span>
  </div>
  <!-- Row 2: Straight Line details -->
  <div class="route-details-row">
    <span class="route-airport">SFO</span>
    <span class="path-duration" style="font-weight: 500; color: var(--color-text-muted);">11h 15m</span>
    <span class="route-airport">NRT</span>
  </div>
</div>
```

## What to Avoid

- **Misaligned airport codes and durations** — do not stack them inside grid cells in a way that offsets them vertically.
- **Letting flight cards shrink** — always set `flex-shrink: 0` to prevent vertical compression under flex parent containers.
- **Harsh borders on modern bubbles** — prefer box-shadows and subtle border-radius styling.

## Origin
Synthesized from sketches: 001, 002
Source files available in: sources/001-chatbot-search-transition/
