# Public API v1 Documentation

**Base URL:** `https://your-domain.com/api/public/v1`

**Version:** 1.0.0

## Overview

This document describes the public API endpoints for The Solpranos governance and mission system. All endpoints follow a standardized response envelope format and are designed for external integration with the-solpranos.com.

## Response Format

All API responses follow this standard envelope:

### Success Response

```json
{
  "success": true,
  "data": { /* response data */ },
  "error": null,
  "meta": {
    "version": "1.0.0",
    "timestamp": "2024-03-24T12:00:00.000Z",
    "count": 10,      // optional: number of items returned
    "total": 100,     // optional: total items available
    "limit": 50,      // optional: pagination limit
    "offset": 0       // optional: pagination offset
  }
}
```

### Error Response

```json
{
  "success": false,
  "data": null,
  "error": {
    "message": "Error description",
    "code": "ERROR_CODE",
    "details": null   // optional: additional error context
  },
  "meta": {
    "version": "1.0.0",
    "timestamp": "2024-03-24T12:00:00.000Z"
  }
}
```

### Error Codes

- `BAD_REQUEST` - Invalid request parameters (HTTP 400)
- `UNAUTHORIZED` - Authentication required (HTTP 401)
- `FORBIDDEN` - Insufficient permissions (HTTP 403)
- `NOT_FOUND` - Resource not found (HTTP 404)
- `VALIDATION_ERROR` - Validation failed (HTTP 400)
- `RESOURCE_CONFLICT` - Resource conflict (HTTP 409)
- `INTERNAL_ERROR` - Server error (HTTP 500)

## Authentication

Public API endpoints do not require authentication. Admin endpoints (not documented here) require Discord OAuth session authentication.

## CORS

The API supports CORS for the following origins:
- `https://the-solpranos.com`
- `https://www.the-solpranos.com`
- `http://localhost:3000`
- `http://localhost:5173`

Allowed methods: `GET, POST, PUT, DELETE, OPTIONS`

## Rate Limiting

Currently no rate limiting is enforced. Please use the API responsibly.

---

## Endpoints

### Governance

#### Get Active Proposals

Returns all proposals currently in voting status.

**Endpoint:** `GET /proposals/active`

**Response Schema:**

```json
{
  "success": true,
  "data": {
    "proposals": [
      {
        "proposalId": "550e8400-e29b-41d4-a716-446655440000",
        "title": "Proposal Title",
        "description": "Proposal description text",
        "status": "voting",
        "creatorId": "1234...5678",  // Redacted for privacy
        "votes": {
          "yes": { "vp": 1500, "count": 25 },
          "no": { "vp": 800, "count": 12 },
          "abstain": { "vp": 200, "count": 5 }
        },
        "quorum": {
          "required": 30,
          "current": 45
        },
        "deadline": "2024-03-30T23:59:59.000Z",
        "createdAt": "2024-03-24T12:00:00.000Z"
      }
    ]
  },
  "meta": {
    "version": "1.0.0",
    "timestamp": "2024-03-24T15:30:00.000Z",
    "count": 1
  }
}
```

**Example Request:**

```bash
curl https://your-domain.com/api/public/v1/proposals/active
```

---

#### Get Concluded Proposals

Returns concluded proposals (passed, rejected, or quorum not met).

**Endpoint:** `GET /proposals/concluded`

**Query Parameters:**
- `limit` (optional, default: 50, max: 100) - Number of proposals to return
- `offset` (optional, default: 0) - Pagination offset

**Response Schema:**

```json
{
  "success": true,
  "data": {
    "proposals": [
      {
        "proposalId": "550e8400-e29b-41d4-a716-446655440001",
        "title": "Passed Proposal",
        "description": "Description",
        "status": "passed",
        "creatorId": "1234...5678",
        "votes": {
          "yes": { "vp": 2000, "count": 30 },
          "no": { "vp": 500, "count": 8 },
          "abstain": { "vp": 100, "count": 2 }
        },
        "quorum": {
          "required": 30,
          "current": 52
        },
        "startTime": "2024-03-10T00:00:00.000Z",
        "endTime": "2024-03-17T23:59:59.000Z",
        "createdAt": "2024-03-09T12:00:00.000Z"
      }
    ]
  },
  "meta": {
    "version": "1.0.0",
    "timestamp": "2024-03-24T15:30:00.000Z",
    "count": 1,
    "total": 45,
    "limit": 50,
    "offset": 0
  }
}
```

**Example Request:**

```bash
curl "https://your-domain.com/api/public/v1/proposals/concluded?limit=20&offset=0"
```

---

#### Get Proposal Details

Returns detailed information about a specific proposal.

**Endpoint:** `GET /proposals/:id`

**Path Parameters:**
- `id` - Proposal UUID

**Response Schema:**

```json
{
  "success": true,
  "data": {
    "proposal": {
      "proposalId": "550e8400-e29b-41d4-a716-446655440000",
      "title": "Proposal Title",
      "description": "Full proposal description with details",
      "status": "voting",
      "creatorId": "1234...5678",
      "votes": {
        "yes": { "vp": 1500, "count": 25 },
        "no": { "vp": 800, "count": 12 },
        "abstain": { "vp": 200, "count": 5 }
      },
      "quorum": {
        "required": 30,
        "current": 45
      },
      "startTime": "2024-03-24T00:00:00.000Z",
      "endTime": "2024-03-31T23:59:59.000Z",
      "createdAt": "2024-03-23T12:00:00.000Z"
    }
  },
  "meta": {
    "version": "1.0.0",
    "timestamp": "2024-03-24T15:30:00.000Z"
  }
}
```

**Error Response (404):**

```json
{
  "success": false,
  "data": null,
  "error": {
    "message": "Proposal not found",
    "code": "NOT_FOUND",
    "details": null
  },
  "meta": {
    "version": "1.0.0",
    "timestamp": "2024-03-24T15:30:00.000Z"
  }
}
```

**Example Request:**

```bash
curl https://your-domain.com/api/public/v1/proposals/550e8400-e29b-41d4-a716-446655440000
```

---

#### Get Governance Statistics

Returns overall governance statistics.

**Endpoint:** `GET /stats`

**Response Schema:**

```json
{
  "success": true,
  "data": {
    "stats": {
      "totalProposals": 127,
      "passedProposals": 83,
      "passRate": 65,
      "totalVotes": 1542,
      "totalVPUsed": 45231,
      "activeVoters": 156
    }
  },
  "meta": {
    "version": "1.0.0",
    "timestamp": "2024-03-24T15:30:00.000Z"
  }
}
```

**Example Request:**

```bash
curl https://your-domain.com/api/public/v1/stats
```

---

### Treasury

#### Get Treasury Summary

Returns treasury balance summary (no sensitive wallet addresses).

**Endpoint:** `GET /treasury`

**Response Schema:**

```json
{
  "success": true,
  "data": {
    "enabled": true,
    "totalUSD": 125340.50,
    "solBalance": 500.25,
    "solPrice": 100.50,
    "tokens": [
      {
        "symbol": "USDC",
        "balance": 50000,
        "usdValue": 50000,
        "decimals": 6
      },
      {
        "symbol": "BONK",
        "balance": 1000000,
        "usdValue": 250.75,
        "decimals": 5
      }
    ]
  },
  "meta": {
    "version": "1.0.0",
    "timestamp": "2024-03-24T15:30:00.000Z",
    "lastUpdated": "2024-03-24T14:00:00.000Z"
  }
}
```

**Example Request:**

```bash
curl https://your-domain.com/api/public/v1/treasury
```

#### Get Treasury Transactions Feed

Returns recent SOL transaction history for treasury wallet (incoming/outgoing deltas).

**Endpoint:** `GET /treasury/transactions?limit=20`

**Example Request:**

```bash
curl "https://your-domain.com/api/public/v1/treasury/transactions?limit=20"
```

#### Get NFT Activity Feed

Returns recent NFT activity events for watched collections.

**Endpoint:** `GET /nft/activity?limit=20`

**Example Request:**

```bash
curl "https://your-domain.com/api/public/v1/nft/activity?limit=20"
```

---

### Missions

#### Get Active Missions

Returns all active and recruiting missions.

**Endpoint:** `GET /missions/active`

**Response Schema:**

```json
{
  "success": true,
  "data": {
    "missions": [
      {
        "missionId": "mission-001",
        "title": "The Big Score",
        "description": "High-stakes heist mission",
        "status": "recruiting",
        "totalSlots": 5,
        "filledSlots": 3,
        "rewardPoints": 500,
        "participants": [
          {
            "participantId": "1234...5678",  // Redacted
            "nftName": "Soprano #123",
            "role": "Driver"
          }
        ],
        "createdAt": "2024-03-20T12:00:00.000Z"
      }
    ]
  },
  "meta": {
    "version": "1.0.0",
    "timestamp": "2024-03-24T15:30:00.000Z",
    "count": 1
  }
}
```

**Example Request:**

```bash
curl https://your-domain.com/api/public/v1/missions/active
```

---

#### Get Completed Missions

Returns completed missions.

**Endpoint:** `GET /missions/completed`

**Query Parameters:**
- `limit` (optional, default: 50, max: 100) - Number of missions to return
- `offset` (optional, default: 0) - Pagination offset

**Response Schema:**

```json
{
  "success": true,
  "data": {
    "missions": [
      {
        "missionId": "mission-002",
        "title": "Completed Heist",
        "description": "Successfully completed mission",
        "status": "completed",
        "totalSlots": 4,
        "rewardPoints": 400,
        "participants": [
          {
            "participantId": "1234...5678",
            "nftName": "Soprano #456",
            "role": "Hacker",
            "pointsAwarded": 400
          }
        ],
        "startTime": "2024-03-15T10:00:00.000Z",
        "createdAt": "2024-03-14T08:00:00.000Z"
      }
    ]
  },
  "meta": {
    "version": "1.0.0",
    "timestamp": "2024-03-24T15:30:00.000Z",
    "count": 1,
    "total": 67,
    "limit": 50,
    "offset": 0
  }
}
```

**Example Request:**

```bash
curl "https://your-domain.com/api/public/v1/missions/completed?limit=10"
```

---

#### Get Mission Details

Returns detailed information about a specific mission.

**Endpoint:** `GET /missions/:id`

**Path Parameters:**
- `id` - Mission ID

**Response Schema:**

```json
{
  "success": true,
  "data": {
    "mission": {
      "missionId": "mission-001",
      "title": "The Big Score",
      "description": "High-stakes heist requiring coordination",
      "status": "active",
      "totalSlots": 5,
      "filledSlots": 5,
      "rewardPoints": 500,
      "participants": [
        {
          "participantId": "1234...5678",
          "nftName": "Soprano #123",
          "role": "Driver",
          "pointsAwarded": 0,
          "joinedAt": "2024-03-20T14:30:00.000Z"
        }
      ],
      "startTime": "2024-03-21T00:00:00.000Z",
      "createdAt": "2024-03-20T12:00:00.000Z"
    }
  },
  "meta": {
    "version": "1.0.0",
    "timestamp": "2024-03-24T15:30:00.000Z"
  }
}
```

**Error Response (404):**

```json
{
  "success": false,
  "data": null,
  "error": {
    "message": "Mission not found",
    "code": "NOT_FOUND",
    "details": null
  },
  "meta": {
    "version": "1.0.0",
    "timestamp": "2024-03-24T15:30:00.000Z"
  }
}
```

**Example Request:**

```bash
curl https://your-domain.com/api/public/v1/missions/mission-001
```

---

### Leaderboard

#### Get Leaderboard

Returns the top leaderboard (max 100 users).

**Endpoint:** `GET /leaderboard`

**Query Parameters:**
- `limit` (optional, default: 100, max: 100) - Number of entries to return

**Response Schema:**

```json
{
  "success": true,
  "data": {
    "leaderboard": [
      {
        "rank": 1,
        "userId": "1234...5678",  // Redacted for privacy
        "username": "TheBoss",
        "tier": "Don",
        "totalPoints": 5420,
        "missionsCompleted": 23
      },
      {
        "rank": 2,
        "userId": "8765...4321",
        "username": "Consigliere",
        "tier": "Underboss",
        "totalPoints": 4180,
        "missionsCompleted": 19
      }
    ]
  },
  "meta": {
    "version": "1.0.0",
    "timestamp": "2024-03-24T15:30:00.000Z",
    "count": 2
  }
}
```

**Example Request:**

```bash
curl "https://your-domain.com/api/public/v1/leaderboard?limit=50"
```

---

#### Get User Leaderboard Position

Returns a specific user's leaderboard position and stats.

**Endpoint:** `GET /leaderboard/:userId`

**Path Parameters:**
- `userId` - Discord user ID

**Response Schema:**

```json
{
  "success": true,
  "data": {
    "user": {
      "userId": "1234...5678",
      "username": "TheBoss",
      "tier": "Don",
      "totalPoints": 5420,
      "missionsCompleted": 23,
      "rank": 1
    }
  },
  "meta": {
    "version": "1.0.0",
    "timestamp": "2024-03-24T15:30:00.000Z"
  }
}
```

**Response (User with no points):**

```json
{
  "success": true,
  "data": {
    "user": {
      "userId": "9999...0000",
      "totalPoints": 0,
      "missionsCompleted": 0,
      "rank": null
    }
  },
  "meta": {
    "version": "1.0.0",
    "timestamp": "2024-03-24T15:30:00.000Z"
  }
}
```

**Example Request:**

```bash
curl https://your-domain.com/api/public/v1/leaderboard/123456789012345678
```

---

## Privacy & Security

### Data Redaction

The public API implements privacy protection:

- **Discord IDs**: Redacted to show only first 4 and last 4 characters (e.g., `1234...5678`)
- **Wallet Addresses**: Never exposed in public endpoints
- **NFT Mint Addresses**: Not included in public responses
- **Internal Config**: Admin settings and secrets are never exposed

### Sensitive Fields

The following fields are **never** included in public API responses:
- Raw wallet addresses (Solana)
- NFT mint addresses
- Discord access tokens
- Session secrets
- Internal database IDs
- Private configuration values

---

## Backward Compatibility

Legacy endpoints without `/v1` prefix remain available for backward compatibility:

- `/api/public/proposals/active` → redirects to `/api/public/v1/proposals/active`
- `/api/public/treasury` → redirects to `/api/public/v1/treasury`
- etc.

These legacy endpoints will continue to work but may be deprecated in future versions.

---

## Changelog

### v1.0.0 (2024-03-24)
- Initial public API release
- Standardized response envelope
- Privacy-first data redaction
- Pagination support for list endpoints
- Comprehensive error handling
- CORS configuration for the-solpranos.com

---

## Support

For API support or integration questions:
- GitHub Issues: [Repository URL]
- Discord: [Server Invite]

**Last Updated:** 2024-03-24
