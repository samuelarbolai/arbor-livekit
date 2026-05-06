# Cloud Functions Programming Style Guide

This document outlines the specific programming patterns and style guidelines to be followed when developing cloud functions for this project. Adherence to these patterns ensures consistency, maintainability, and reliability.

## 1. Cloud Function Patterns (The "Dispatcher")

These patterns focus on reliability, high-performance querying, and localized code maintenance within cloud environments.

### A. Defensive "Fire-and-Log" Batching
To ensure high availability for mass operations (like outbound calls), the code avoids the default `Promise.all` behavior where a single failure rejects the entire batch. Instead, a "fire-and-forget-error" pattern is used.

**Implementation:** Wrap individual asynchronous calls in a `.catch()` block within the `.map()` function.

```typescript
async function startBatch(users: string[]) {
  // One failure won't stop the other 49 calls
  await Promise.all(
    users.map((id) => makeCall(id).catch((err) => console.error(`Failed for ${id}:`, err)))
  );
}
```

### B. O(1) String-Key Scheduling
Avoid complex database range queries (e.g., `time > start AND time < end`). Use the native `Intl` API to generate a deterministic string key for direct equality matches.

**Implementation:** Combine the day of the week and a rounded time into a single uppercase string.

```typescript
const now = new Date(); // e.g., Monday 9:32 AM
const day = new Intl.DateTimeFormat('en-US', { weekday: 'short' }).format(now).toUpperCase(); // "MON"
const time = "09:30"; // Rounded to nearest 30m
const scheduleKey = `${day}_${time}`; // "MON_09:30"

// High-performance Firestore query
const snapshots = await db.collection("jobs").where("schedules", "array-contains", scheduleKey).get();
```

### C. Scoped Interface Declaration
Favor "Locality of Behavior." Define data contracts exactly where the JSON is parsed or sent rather than in a global types file.

**Implementation:** Declare the interface inside the function block.

```typescript
export const myHandler = onRequest(async (req, res) => {
  interface IncomingPayload {
    userId: string;
    action: 'start' | 'stop';
  }
  const data = req.body as IncomingPayload; // Trusting the input shape
});
```

## 2. Shared TypeScript Idioms

General coding practices applied across the entire project.

| Pattern           | Description                                 | Benefit                            |
| :---------------- | :------------------------------------------ | :--------------------------------- |
| Pragmatic Safety  | Use `!` and `as` for environment variables and known shapes. | Prioritizes shipping and reduces boilerplate. |
| Lookup Tables     | Use object literals instead of `if/else` or `switch`. | Improved clarity and readability.  |
| Lazy Singletons   | Initialize expensive services only once with a flag. | Optimizes performance and resource usage. |

**Example: Lazy Singleton**
```typescript
let initialized = false;
function init() {
  if (initialized) return;
  initializeApp();
  initialized = true;
}
```
