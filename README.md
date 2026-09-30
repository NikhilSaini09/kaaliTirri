# Kaali Tirri (3 Patti Variant)

Kaali Tirri is a 100% free, serverless, web-based multiplayer card game built for 5-6 players. It runs entirely peer-to-peer using WebRTC, meaning there are no central databases or servers storing your data.

Play directly in your browser: [Play Kaali Tirri](https://nikhilsaini09.github.io/kaaliTirri/)

## Overview

Kaali Tirri is a trick-taking game with dynamic team alliances and an open bidding system.

* **The Deck:** Standard 52-card deck. Normal rankings apply (2 to Ace).
* **Card Values:**
  * Aces, Kings, Queens, Jacks, and 10s: 10 Points
  * 5s: 5 Points
  * 3 of Spades (Kaali Tirri): 30 Points
* **Players:** Any number of people can be in the room, but only the ticked ones (minimum 2, designed for 7-8 max) are dealt in. Everyone else watches as a spectator.
* **Bidding:** Players iteratively raise the bid (minimum 130, maximum 250 in multiples of 5) or fold. The highest bidder dictates the game terms.
* **Trump & Teams:** The highest bidder selects the "Cart" (Trump suit) and calls out "Team Cards" based on the number of players. The players holding these called cards become the secret teammates of the bidder.
* **The Reveal:** Alliances remain secret until a player physically plays a called team card, exposing them as either a Bidder or Defender.

## Rules of the Game

### Card Info

Deck: 52 cards, no jokers.

---

### Points for each card

* 2, 4, 6, 7, 8, 9 of each of the 4 suits = 0 pts
* 3 of Spades = 30 pts (3 of other suits = 0 pts)
* 5 of each of the suits = 5 pts
* 10, J, Q, K, A of each of the suits = 10 pts

Max possible points = 30 \+ (5 \* 4) \+ (10 \* 5 \* 4) = 250 pts

### Rank of card

---> Increasing order
2 3 4 5 6 7 8 9 10 J Q K A

---

### Distribution & Auction

All 52 cards are distributed randomly and evenly to the active players; any remainder is discarded. Hands are automatically sorted by suit and rank for convenience.

After reviewing their cards, players begin the **Bidding Phase**. The minimum bid is 130 pts and the maximum is 250 pts.
Whoever bids highest (or hits 250 first) is the "BID_WINNER". If the initial 30-second timer expires with no bids, a random player is forcefully assigned as the BID_WINNER with 130 pts.

The BID_WINNER gets to choose two things:

1. TRUMP_SUIT (The Cart)
2. PARTNER_CARD(S) (Suit + Card Number) - The number of partner cards scales with the player count.

Players holding the PARTNER_CARD(S) and the BID_WINNER form the Bidder Team, while all remaining players form the Defender Team. Partner identities are kept completely secret from the table until they physically play the called card.

---

### Round of Cards

Players take turns in clockwise order. The first trick is led by the BID_WINNER, and all subsequent tricks are led by the previous trick's winner.

For each trick, the suit of the led card must be followed. If a player does not have a card of the led suit, they may play a card from the TRUMP_SUIT or any other suit. The highest rank of the led suit wins the trick, unless a TRUMP_SUIT card is played, in which case the highest trump wins.

The score of the trick is added to the winner's total, and the cards are moved to their "Won Pile" (which can be inspected by clicking on it).

At the end of all tricks, team scores are aggregated. If the Bidder Team's score is strictly greater than or equal to the BIDDING_AMOUNT, they win. Otherwise, the Defender Team wins.

Players have 30 seconds to play a card. If the timer expires, the engine automatically plays a valid card for them.

## Features

* **Peer-to-Peer Networking:** Hosted locally by the room creator using WebRTC (PeerJS).
* **Firewall Bypass:** Utilizes Google STUN and OpenRelay TURN servers to ensure connections succeed across strict NATs and corporate networks.
* **Anti-Cheat Architecture:** The game state is sanitized before broadcasting. Opponents' hands are hidden at the memory level to prevent cheating via the browser console.
* **Host-Controlled Seating & Order:** In the waiting room, the host can tick/untick players to assign them to active play or spectator status. The host can also manually reorder the turn cycle using arrow controls.
* **Host Migration:** The active host can promote another active player to become the new host, seamlessly migrating the room logic without dropping connections.
* **Code-Based Join & Seamless Reconnection:** Supports a `playerData` array to map secret codes to names. If a player gets disconnected or closes their tab, they can re-enter their code in a new window to seamlessly override their dead connection and jump right back into their seat mid-hand. Disconnected players are skipped instantly during trick evaluation to prevent game stalls.
* **Dynamic Save/Load State:** Games can be paused, saved as a JSON file, and restored later. The loading engine dynamically remaps live network IDs to the saved player data, preserving exact turn orders and shunting overflow players into the spectator pool.
* **Quality of Life (Audio & UI):** Features native Web Audio API sound cues for card plays, turn notifications, and 5-second countdown warnings — heard by every player at the table, not just the one acting. A glowing highlight marks both whoever's turn it is and, mid-trick, whichever played card is currently winning it.
* **Persistent Statistics:** Tracks career wins, losses, total games played, and win rates across sessions using the save file ledger.
* **Sanitized Display Names:** Names are escaped before being rendered to prevent XSS string injections.

## Architecture

This project strictly utilizes HTML, CSS, and vanilla JavaScript without external frameworks, relying on a Single Page Application (SPA) architecture to preserve the WebRTC connection state.

* `index.html`: Holds the container views (Landing, Lobby, Game Board).
* `style.css`: Implements the responsive, radial casino-table UI.
* `network.js`: Manages the PeerJS connections, STUN/TURN routing, and state broadcasting.
* `game.js`: The pure logic engine (State Machine, Shuffle, Trick Evaluation, Bidding Logic).
* `ui.js`: The frontend render layer connecting the state engine to the DOM.

## Local Development

If you wish to clone and run the game locally, you do not need a Node.js server.

1. Clone the repository.
2. Open `index.html` in any modern web browser.
3. WebRTC functions natively over `localhost` and local file protocols (`file:///`).