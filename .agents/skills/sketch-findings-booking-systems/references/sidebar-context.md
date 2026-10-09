# Sidebar Context

## Design Decisions

**Persistent trip summary** — shows trip steps (flight, hotel, dining) with status indicators (Confirmed/Pending). Users always know where they are in the booking journey without asking the AI.

**Passenger info card** — displays passenger names, seat assignments. Visible during booking flow so users can confirm details without switching screens.

**Payment status card** — shows payment method, amount, and status (Awaiting Payment/Confirmed). Keeps payment context visible during the conversation.

**Sticky pay button** — primary CTA at the bottom of the sidebar for quick access to payment.

## CSS Patterns

```css
.trip-summary {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 12px;
  padding: 20px;
  box-shadow: var(--shadow-card);
}

.trip-step {
  display: flex;
  gap: 12px;
  padding: 10px 0;
  border-bottom: 1px solid var(--color-border);
}

.passenger-card {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 12px;
  padding: 16px;
}
```

## HTML Structure

```
split-sidebar
├── trip-summary
│   ├── title ("Trip to Los Angeles")
│   └── trip-step (repeated)
│       ├── icon (flight/hotel/dining)
│       ├── text (name + sub)
│       └── status (Confirmed/Pending)
├── passenger-card
│   ├── title ("Passengers")
│   └── rows (Name, Seat for each passenger)
├── passenger-card (payment)
│   ├── title ("Payment")
│   ├── rows (Method, Amount, Status)
│   └── badge (Awaiting Payment / Confirmed)
└── pay-now button (primary, full-width)
```

## What to Avoid

- **Empty sidebar** — if no trip context yet, show a helpful prompt instead of blank space
- **Too many cards stacked** — max 3-4 cards before it feels heavy; collapse or paginate if needed
- **Sidebar wider than 360px** — reduces chat space too much on standard screens

## Origin
Synthesized from sketches: 002
Source files available in: sources/002-chatbot-booking/
