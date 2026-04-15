# BuildMyTracks v1

A React Native mobile app built with Expo that tracks a user's GPS location in real time — including background tracking, pause/resume, and a persistent privacy notice.

## Features

- **Get Current Location** — retrieves a single high-accuracy GPS fix and displays latitude and longitude
- **Live Tracking** — continuously updates coordinates in real time using the device's location service
- **Background Tracking** — continues logging GPS coordinates when the app is minimized, the screen is locked, or the user switches apps (requires "Allow all the time" permission)
- **Pause & Resume** — temporarily suspends location updates without clearing the session log; resumes seamlessly from where it left off
- **Session Log** — tracks the total number of coordinate points recorded during the active session
- **Privacy Notice** — a persistent on-screen notice explaining what data is collected, when, how it is stored, and how the user can control it

## Tech Stack

| Package | Purpose |
|---|---|
| [Expo](https://expo.dev) ~54 | Managed React Native framework |
| [expo-location](https://docs.expo.dev/versions/latest/sdk/location/) ~19 | Foreground and background GPS access |
| [expo-task-manager](https://docs.expo.dev/versions/latest/sdk/task-manager/) ~14 | Background location task execution |
| React Native 0.81 | Core mobile UI framework |
| TypeScript | Static typing |

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org) 18 or later
- [Expo CLI](https://docs.expo.dev/get-started/installation/) — install with `npm install -g expo-cli`
- A physical device or emulator (GPS features require a real device for full testing)
- [Expo Go](https://expo.dev/client) app installed on your device

### Installation

```bash
# Clone the repository
git clone https://github.com/blburks/LocationTracking.git
cd LocationTracking

# Install dependencies
npm install

# Start the development server
npx expo start
```

Scan the QR code with Expo Go (Android) or the Camera app (iOS) to open the app on your device.

## Permissions

The app requests the following permissions at runtime:

| Permission | When | Why |
|---|---|---|
| Location (foreground) | On first use of any tracking feature | Required to read GPS coordinates |
| Location (background) | When starting live tracking | Required to continue tracking when the app is not in the foreground |

On Android, background location also requires `ACCESS_BACKGROUND_LOCATION` and a foreground service notification, both of which are configured in `app.json`.

On iOS, `NSLocationAlwaysAndWhenInUseUsageDescription` and `UIBackgroundModes: ["location"]` are set in `app.json`.

## Project Structure

```
LocationTracking/
├── index.tsx        # App entry point — all UI and tracking logic
├── app.json         # Expo config (permissions, background modes)
├── package.json     # Dependencies
└── assets/          # App icons and splash screen
```

## Privacy

All recorded coordinates are stored in memory on the device only for the duration of the session. No location data is uploaded, shared, or transmitted to any external server.
