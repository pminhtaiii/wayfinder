# Map Integration Architecture

**Date**: 2026-07-05 | **Feature**: 005-map-integration

This document captures the architectural research and decisions for adding interactive map visualization to the Flight Booking System.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        Frontend (Next.js)                       │
│                                                                 │
│  ┌──────────────┐  ┌──────────────────────────────────────────┐ │
│  │ Search Page   │  │ Map Components ("use client")           │ │
│  │ (/search)     │──│ ┌────────────────────────────────────┐  │ │
│  │               │  │ │ MapContainer (react-map-gl)        │  │ │
│  │ Flight Detail │  │ │ ├── AirportMarkerLayer (clustered) │  │ │
│  │ (/search/[id])│  │ │ ├── FlightRouteLayer (arcs)       │  │ │
│  │               │  │ │ ├── AirportPopup                   │  │ │
│  │ Homepage      │  │ │ └── MapControls                    │  │ │
│  │ (/)           │  │ └────────────────────────────────────┘  │ │
│  └──────┬───────┘  └──────────────┬───────────────────────────┘ │
│         │                         │                              │
│         │    airport-service.ts   │   MapLibre GL JS             │
│         │    (API client)         │   (WebGL rendering)          │
│         └────────┬────────────────┘                              │
└──────────────────┼───────────────────────────────────────────────┘
                   │ HTTP (REST)
┌──────────────────┼───────────────────────────────────────────────┐
│                  ▼       Backend (NestJS)                        │
│  ┌──────────────────────────────────┐                            │
│  │ AirportsModule                   │                            │
│  │ ├── AirportsController           │                            │
│  │ │   ├── GET /airports/search     │ ◄── Redis Cache (24h)     │
│  │ │   ├── GET /airports/:iataCode  │ ◄── Redis Cache (24h)     │
│  │ │   ├── GET /airports/nearby     │ ◄── Redis Cache (1h)      │
│  │ │   └── GET /airports/all        │ ◄── Redis Cache (24h)     │
│  │ └── AirportsService              │                            │
│  │     └── Haversine distance calc  │                            │
│  └──────────────┬───────────────────┘                            │
│                 │ Prisma ORM                                     │
│  ┌──────────────▼───────────────────┐                            │
│  │ PostgreSQL                        │                            │
│  │ └── airports table (~7,700 rows) │                            │
│  │     Seeded from OurAirports CSV  │                            │
│  └───────────────────────────────────┘                            │
└───────────────────────────────────────────────────────────────────┘

External (no API cost):
┌─────────────────────────────┐
│ OpenFreeMap / MapTiler       │
│ (Vector tile source — free) │
└─────────────────────────────┘
```

---

## Key Decisions

### 1. MapLibre GL JS over Mapbox/Google/Leaflet

MapLibre is the open-source fork of Mapbox GL JS v1. It provides identical WebGL rendering quality without the proprietary license or API key requirements of Mapbox v2+. The `react-map-gl` wrapper by Uber provides first-class React integration.

### 2. PostgreSQL over Static JSON for Airport Data

Storing airports in PostgreSQL (seeded from OurAirports CSV) enables server-side querying (search, nearby), Redis caching, and keeps the frontend bundle small. A static JSON approach would add ~800KB to the frontend bundle.

### 3. Haversine over PostGIS for Distance Queries

With only ~7,700 airports, the Haversine formula on plain FLOAT columns is sufficient for proximity queries. PostGIS adds operational complexity (extension installation, index types) that isn't justified at this scale.

### 4. Turf.js Great-Circle over deck.gl ArcLayer

`@turf/great-circle` is a ~5KB module that produces geographically accurate GeoJSON arcs. deck.gl's ArcLayer adds ~150KB and requires an additional integration layer. The visual difference is minimal for 2D projected maps.

### 5. Public Endpoints (No Auth Required)

Airport data is non-sensitive, static, and publicly available. Making endpoints public allows the map to render before login (homepage, explore page) and reduces auth overhead.

---

## Data Flow: Search → Map

```
User types "HAN" in origin field
        ↓
Frontend calls GET /airports/search?q=HAN
        ↓
NestJS checks Redis cache (key: airports:search:{hash})
        ├── Cache HIT → return cached results
        └── Cache MISS ↓
            Prisma queries airports table (ILIKE on name/iataCode)
                ↓
            Results cached in Redis (TTL: 24h)
                ↓
            Airport data returned to frontend
                ↓
User selects "HAN - Noi Bai International Airport"
        ↓
Frontend places marker on map at (21.2212, 105.807)
        ↓
User selects destination "NRT" (same flow)
        ↓
Frontend computes great-circle arc via @turf/great-circle
        ↓
Arc rendered as GeoJSON LineString layer on map
        ↓
Map viewport auto-fits to show both markers
```

---

## Bundle Impact Analysis

| Package              | Gzipped Size | Purpose                 |
| -------------------- | ------------ | ----------------------- |
| `maplibre-gl`        | ~200KB       | Core WebGL map engine   |
| `react-map-gl`       | ~35KB        | React wrapper           |
| `@turf/great-circle` | ~5KB         | Arc computation         |
| `@turf/helpers`      | ~3KB         | GeoJSON utilities       |
| **Total**            | **~243KB**   | Well under 500KB budget |

All map packages are code-split via `dynamic()` — they don't affect the initial page load of non-map pages.

---

## Constitution Compliance

This feature fully complies with all 5 constitutional principles:

1. **Flight-First**: Map is a visual enhancement to the existing search — it doesn't add steps to booking
2. **Deterministic Boundary**: Zero AI involvement, all data is static and deterministic
3. **API Budget**: Zero Amadeus API calls — all airport data from local seed
4. **Observability**: Standard NestJS logging and health check patterns
5. **Incremental**: 7 independently deliverable phases
