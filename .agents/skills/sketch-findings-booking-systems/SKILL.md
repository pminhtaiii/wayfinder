---
name: sketch-findings-booking-systems
description: Validated design decisions, CSS patterns, and visual direction from sketch experiments. Auto-loaded during UI implementation on Booking Systems.
---

<context>
## Project: Booking Systems (Flight Booking System)

Clean, modern chatbot-first flight booking UI with a purple primary accent. Users converse with an AI agent to search, compare, and book flights. Starts as a centered, focused chat page, and then dynamically slides to a split view (chatbot on left, search results list on right) upon flight queries.

Reference points:
- Travel booking apps (Kayak, Google Flights) for layout patterns
- ChatGPT-style conversational interfaces for chat flow
- Amadeus API data shapes for flight results

Sketch sessions wrapped: 2026-06-23, 2026-07-02
</context>

<design_direction>
## Overall Direction

**Layout:** Initial view is a centered chat column (~680px max-width). Results state triggers a split view: chat column slides left (~35-38% width) and results list expands on right (~62-65% width). Persistent trip context sidebar is docked right.

**Palette:** Purple primary (#7C5CFC), white card surfaces, light gray backgrounds (#F5F6FA), borders (#E7EAF3). Status colors: green for success/confirmed, amber for warning/pending, red for danger/cancelled. Match scores: green (80-100), blue (60-79), orange (<60).

**Typography:** Inter font. 16px/600 for section headings, 14px/500 for body, 12px/400 for muted text.

**Components:** Flight cards and booking confirmations render inline as rich messages in chat. Match score pills with mini progress bars. Quick action chips below input. Typing indicator for AI responsiveness. Flight route segments display times, airports, and duration horizontally on straight lines.

**Interaction:** Conversational flow — user types or clicks quick actions, AI responds with rich cards, user books through chat. Workspace container scales and opacity-fades elements smoothly on transition.
</design_direction>

<findings_index>
## Design Areas

| Area | Reference | Key Decision |
|------|-----------|--------------|
| Chatbot Layout & Flow | references/chatbot-layout-and-flow.md | Starts centered; slides left and reveals results on right with smooth cubic-bezier transition. |
| Rich Message Components | references/rich-message-components.md | Gradient user chat bubbles, inline flight cards with horizontal route lines, and non-shrinking cards. |
| Sidebar Context | references/sidebar-context.md | Trip steps, passenger info, payment status always visible. |
| Input & Quick Actions | references/input-and-quick-actions.md | Pill-shaped input wrapper with inline circle send button and tactile hover chips. |

## Theme

The winning theme file is at `sources/themes/default.css`.

## Source Files

Original sketch HTML files are preserved in `sources/` for complete reference.
</findings_index>

<metadata>
## Processed Sketches

- 001-chatbot-search-transition
- 002-chatbot-booking
</metadata>
