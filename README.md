# Kaali Tirri (3 Patti Variant)

Kaali Tirri is a 100% free, serverless, web-based multiplayer card game built for 2 to 10 players. It runs entirely peer-to-peer using WebRTC, meaning there are no central databases, user accounts, or backend servers storing your data.

Play directly in your browser: [Play Kaali Tirri](https://nikhilsaini09.github.io/kaaliTirri/)

---

## Overview

Kaali Tirri is a highly strategic trick-taking game featuring dynamic, secret team alliances and an open bidding system.

* **The Deck:** Standard 52-card deck (no jokers). Traditional card rankings apply (2 through Ace).
* **High-Value Target Cards:**
  * **3 of Spades (Kaali Tirri):** **30 Points**
  * **Aces, Kings, Queens, Jacks, 10s:** **10 Points each** (all suits)
  * **5s:** **5 Points each** (all suits)
  * All other cards (2, 4, 6, 7, 8, 9, and non-spade 3s): **0 Points**
  * **Total Table Points:** **250 Points**
* **Flexible Player Count (2–10 Players):** Any number of people can join a room. The host selects which players are seated (minimum 2, optimally 4–6), while unseated participants seamlessly spectate the live board.
* **Dynamic Bidding System:** Players compete in an auction round to become the Bid Winner. Minimum bids adapt dynamically based on the seated player count (80, 120, or 140 pts) up to 250 pts in multiples of 5.
* **Trump Suit ("Cart") & Secret Partners:** The highest bidder selects the Trump suit and calls partner cards based on player count (`Math.floor((N - 2) / 2)`). The players holding these called cards form the secret **Bidder Team**, while everyone else forms the **Defender Team**.
* **The Dramatic Reveal:** Alliances remain completely concealed until a player plays a called partner card onto the table, exposing their true loyalty.

---

## Rules of the Game

### Card Values & Rankings

| Card | Points |
| :--- | :--- |
| **3 of Spades (♠3 - Kaali Tirri)** | **30 pts** |
| **10, J, Q, K, A** (all 4 suits) | **10 pts each** (200 pts total) |
| **5** (all 4 suits) | **5 pts each** (20 pts total) |
| **2, 4, 6, 7, 8, 9**, and **3♥ / 3♦ / 3♣** | **0 pts** |
| **Total Possible Points** | 30 \+ (5 \* 4) \+ (10 \* 5 \* 4) = **250 pts** |

**Card Rank (Lowest to Highest):**  
`2` → `3` → `4` → `5` → `6` → `7` → `8` → `9` → `10` → `J` → `Q` → `K` → `A`

---

### Deal & Bidding Phase

1. **Card Dealing:** All 52 cards are distributed evenly among active seated players. Any remaining cards are discarded before play begins (lowest-value non-point cards are removed first). Hands are automatically sorted by suit and rank.
2. **Auction (Bidding):**
   * Bids must be made in **multiples of 5** between the table's minimum bid and 250 pts.
   * **Dynamic Minimum Bids:**
     * **2–3 Players:** Minimum **80 pts**
     * **4 Players:** Minimum **120 pts**
     * **5+ Players:** Minimum **140 pts**
   * **Turn Timer:** 30 seconds per bidding decision. Each successful raise resets the timer.
   * **Opening Protection:** In mixed human/bot lobbies, AI bots wait 15 seconds before opening bidding to give human players the first opportunity to bid.
   * **Winning the Auction:** The highest bidder when all others fold (or whoever reaches 250 first) becomes the **Bid Winner**. If the initial 30 seconds elapse without any bids, a random player is assigned as the Bid Winner at the minimum bid.

---

### Trump Selection & Partner Cards

The Bid Winner has 60 seconds to select the **Trump Suit ("Cart")** and call **Partner Cards**.

The number of called partner cards scales with player count according to:
$$\text{Partner Cards} = \left\lfloor \frac{N - 2}{2} \right\rfloor$$

| Seated Players ($N$) | Called Partners | Team Breakdown |
| :---: | :---: | :---: |
| **2** | 0 | 1 Bidder vs 1 Defender |
| **3** | 0 | 1 Bidder vs 2 Defenders |
| **4** | 1 | 2 Bidders vs 2 Defenders |
| **5** | 1 | 2 Bidders vs 3 Defenders |
| **6** | 2 | 3 Bidders vs 3 Defenders |
| **7** | 2 | 3 Bidders vs 4 Defenders |
| **8** | 3 | 4 Bidders vs 4 Defenders |
| **9** | 3 | 4 Bidders vs 5 Defenders |
| **10** | 4 | 5 Bidders vs 5 Defenders |

* **Secret Alliances:** Players holding the called cards belong to the Bidder Team. However, no one at the table knows who holds which called card—not even the Bid Winner!
* **Auto-Resolution:** If the 60-second selection timer expires, the game engine automatically selects the bidder's most prominent suit and assigns random unique partner cards.

---

### Trick Play & Scoring

1. **Leading & Following Suit:**
   * The Bid Winner leads the first trick. The winner of each trick leads the next.
   * Play proceeds clockwise.
   * Players **must follow the led suit** if they have a card of that suit.
   * If void in the led suit, a player may play any card, including a Trump card.
2. **Winning the Trick:**
   * The highest rank of the led suit wins the trick unless one or more Trump cards are played.
   * If Trumps are played, the highest-ranking Trump wins.
   * Visual indicators highlight whoever's turn it is and which card is currently winning the trick.
3. **Turn Timers & Disconnection Fallback:**
   * Players have 30 seconds per card play.
   * If the timer expires or a player disconnects, the smart AI automatically selects a legal card to prevent stalls.
4. **End of Round & Victory Condition:**
   * All trick points won by members of the Bidder Team are combined.
   * **Bidder Victory:** Bidder Team score $\ge$ Bid Amount.
   * **Defender Victory:** Bidder Team score $<$ Bid Amount.

---

## Features

### Networking & Connectivity

* **Serverless WebRTC (PeerJS):** Fully decentralized peer-to-peer architecture.
* **NAT / Firewall Traversal:** Built-in STUN (Google) and TURN (OpenRelay) fallback routing for seamless connections across mobile networks and restricted Wi-Fi.
* **Offline Bot Mode:** Can't reach the internet or signaling server? Click **"Play Offline (Bots)"** to instantly launch a local solo session (Room `000000`) with AI opponents.
* **Advanced AI Bots:** Short a few players? The host can seamlessly drop in AI-controlled bots. Bots utilize Monte Carlo simulations, point-feeding heuristics, void-mapping, and statistical risk-margin bidding. Bots adhere to strict fairness rules: they never peek at hidden cards, simulating outcomes solely based on public table memory.
* **Client Anti-Cheat Architecture:** The game state is sanitized before broadcasting. Opponents' hands are hidden at the memory level for all connected peers to prevent cheating via the browser console. *(Note: Because this is a peer-to-peer game, the Room Host acts as the server and holds the unsanitized master state in memory).*
* **Host-Controlled Seating & Order:** In the waiting room, the host can tick/untick players to assign them to active play or spectator status. The host can also manually reorder the turn cycle using arrow controls.
* **Seamless Reconnection & Grace Period:** Disconnected players get a 15-second grace window to reconnect or refresh and reclaim their seat without interrupting the hand.
* **Heartbeat Monitoring:** 5-second heartbeat ping with a 15-second stale threshold to promptly handle packet drops and channel re-openings.
* **Host Migration:** The room host can promote any connected peer to become the new host, migrating game state without terminating peer connections.
* **Dynamic Save/Load State:** Games can be paused, downloaded as a JSON file, and restored days later. The loading engine dynamically remaps live network IDs to the saved player data, preserving exact turn orders, bot memories, and shunting overflow players into the spectator pool.
* **Quality of Life (Audio & UI):** Features native Web Audio API sound cues for card plays, turn notifications, and 5-second countdown warnings — heard by every player at the table, not just the one acting. A glowing highlight marks both whoever's turn it is and, mid-trick, whichever played card is currently winning it.
* **Persistent Statistics:** Tracks career wins, losses, total games played, and win rates across sessions using the save file ledger.
* **Sanitized Display Names:** Names are escaped before being rendered to prevent XSS string injections.

### In-Game Chat & Social Reactions

* **Lobby & In-Game Chat:** Accessible directly in the waiting room and during live rounds (including the pause menu).
* **Unread Counter Badges:** Notification counters (`1`–`9+`) keep players informed of new messages while the chat window is closed.
* **Categorized Emoji Picker:** Features standard emoji categories (Smileys, Gestures, Fun & Games, Animals, Food & Drink) with a native fallback interface.
* **Floating Screen Reactions:** Quick-reaction buttons trigger animated floating emojis across all connected players' screens in real time.
* **Anti-Spam Rate Limiting:** Built-in throttles protect chat and reaction channels against spam.

### AI Bots & Auto-Play

* **Advanced Monte Carlo AI (`smartAiPlayer.js`):** AI opponents evaluate moves using heuristic simulations, point feeding, void tracking, and risk-margin bidding.
* **Strict Fair-Play Anti-Cheat:** Bots never peek at hidden player cards. They simulate outcomes solely based on publicly observed cards and trick memory.
* **Auto-Play Toggle:** Human players can toggle Auto-Play at any time, allowing the AI assistant to play turns automatically.
* **Configurable CPU Count:** Hosts can add up to 7 AI bots in the lobby with a single click.

### Host Controls & Game Management

* **Pause / Resume Game:** The host can pause active games at any moment; all countdown timers pause and resume in sync across peers.
* **Re-Deal / Reshuffle:** The host can restart or redeal a round directly from the host controls dropdown.
* **Save & Load Game Engine:**
  * Export complete game state to a portable JSON file.
  * Load saved games anytime—the engine validates deck integrity, re-maps peer IDs, re-initializes minimum bids, flushes UI caches, and auto-pauses for a clean resume.
* **Seating & Turn Order Customization:** The host can toggle individual players between active and spectator seats, as well as manually reorder seating positions with arrow controls.

### Modals & Quality of Life

* **Trick History Modal:** View a complete, chronological log of every trick played in the round, showing trick numbers, winners, points gained, and winning cards.
* **Won Cards Inspector:** Click any player's won pile to inspect all collected cards grouped by trick.
* **Web Audio Sound Effects:** Synthesized audio cues via the Web Audio API for card plays, turn alerts, and 5-second countdown alarms (no external audio assets required).
* **Responsive Radial UI:** Tailored circular table layout for desktop screens, with automatic responsive adaptation for mobile devices ($\le$ 860px).
* **Anti-Cheat Memory Sanitization:** Player hands are scrubbed from serialized network packets before broadcasting to peer clients.

---

## Project Structure

```bash
KaaliTirri/
├── index.html          # Single Page Application markup & views (Landing, Lobby, Game Table, Modals)
├── style.css           # Radial game table, mobile responsiveness, animations, chat & modal styling
├── game.js             # Core game engine: state machine, card dealing, bidding, trick evaluation
├── network.js          # WebRTC peer connections, STUN/TURN routing, chat broadcasting, rate limits
├── smartAiPlayer.js    # Monte Carlo simulation engine, bot bidding, trump heuristics, card selection
├── ui.js               # DOM rendering layer, event listeners, audio synthesis, save/load handling
└── Assets/             # SVG & WebP brand logos and icons
```

---

## Local Development

No Node.js backend server or build pipeline is required. The entire application runs natively in the browser:

1. **Clone the repository:**

   ```bash
   git clone https://github.com/nikhilsaini09/kaaliTirri.git
   cd kaaliTirri
   ```

2. **Run locally:**
   * Open `index.html` directly in any modern web browser, or
   * Serve with any local HTTP server:

     ```bash
     npx serve .
     # or
     python3 -m http.server 8000
     ```

3. **Multiplayer Testing:**
   * Open two or more browser tabs or windows to simulate host and guest peers.
   * WebRTC operates smoothly over `localhost` and local file protocols (`file:///`).
