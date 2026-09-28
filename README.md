# Kaali Tirri (3 Patti Variant)

Kaali Tirri is a 100% free, serverless, web-based multiplayer card game built for 5-6 players. It runs entirely peer-to-peer using WebRTC, meaning there are no central databases or servers storing your data.

Play directly in your browser: [Play Kaali Tirri](https://nikhilsaini09.github.io/kaaliTirri/)

## Overview & Rules

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

## Features

* **Peer-to-Peer Networking:** Hosted locally by the room creator using WebRTC (PeerJS).
* **Firewall Bypass:** Utilizes Google STUN and OpenRelay TURN servers to ensure connections succeed across strict mobile hotspots and corporate networks.
* **Anti-Cheat Architecture:** The game state is sanitized before broadcasting. Opponents' hands are hidden at the memory level to prevent cheating via the browser console.
* **Host-Controlled Seating:** In the waiting room the host sees a tick box next to every name (everyone starts ticked). Un-tick anyone, including the host, and they join the next game as a spectator; the ticked players are dealt in. Spectators stay spectators when the room returns to the lobby (shown un-ticked), so the host can tick them back in for the next game.
* **Local State Management:** Games can be paused, downloaded as a JSON save file, and reloaded to resume a session later.
* **Persistent Statistics:** Tracks wins, losses, and total games played across sessions using the save file ledger.

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
