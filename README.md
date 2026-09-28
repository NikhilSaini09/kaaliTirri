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

### Card info

Deck: 52 cards, no jokers;

---

### Points for each card

2, 4, 6, 7, 8, 9 of each of the 4 suits = 0 pts

3 of Spades = 30pts; 3 of other suits = 0 pts

5 of each of the suits = 5 pts

10, J, Q, K, A of each of the suits = 10 pts

Max possible = 30 + 5*4 + 10*5*4 = 250 pts

### Rank of card

---> Increasing order
2 3 4 5 6 7 8 9 10 J Q K A

---

### Distribution & Auction

All the 52 cards are distributed randomly to each of the players. Cards are distributed equally extras are discarded.
Now, after they observer their cards they start "# BIDDING", individually. Minimum 130 pts and max 250 pts can be bid.
Whoever bids highest or 250 first is the "BID_WINNER".
Anyone can bid, if no one bids in a given time-frame, then a random player is assigned as BID_WINNER with 130 pts.
BIDDINGA_AMOUNT: the highest bid in the auction.

The BID_WINNER gets to choose two things:

* TRUMP_SUITE
* PARTNER_CARD (suite + cardnumber)

Player holding the PARTNER_CARD and the BID_WINNER are a team, and the remaining ones in other team. (2 teams)
Partner is not revealed to any of the players till he plays that card, except the one as he owns the PARTNER_CARD.

---

### Round of Cards

Players (in clockwise order): p1 -> p2 -> p3 -> p4

Once the above settles, game starts with round of cards. In each round, all the players (in clockwise way) gets a chance to play a card from their own deck.
Each played is visible to everyone the time its played. Say, p1 played "Ace of Spades", then other players get to know it immediately and decide their own card to play accordingly.
First round is started by the BID_WINNER, and the subsequent rounds are started by the previous ROUND_WINNER
For each round, the suit of the card that has to be played will be fixed and is decided by the player who begins the round. ::: -> Say p3 is the one starting the round and played "King of Hearts". Now other players can only play the cards of "Hearts" suit from their deck or any card from the "TRUMP_SUITE" for the particular round. If the players do not have cards from these suits, then only they can play the cards from other suits.
Cards with highest rank wins the round. If card from any TRUMP_SUITE has been played, then the highest rank of the card from the TRUMP_SUITE wins the round.
ROUND_WINNER gets the points calculated as above mentioned points.
Score of each players is always visible to all players.
All the cards played are then discarded and cannot be used in the next rounds.
Whenever the "PARTNER_CARD" is played, the partner of the BID_WINNER is revealed.In the end of all the rounds, the score gets accumulated team-wise. PARTNER_CARD holder + BID_WINNER is Bidder TEAM, and other players in Defender TEAM.
If Bidder TEAM score is greater than or equals to the BIDDING_AMOUNT, they wins else the Defender TEAM wins.
Each player gets 30 sec to play their card, else the system automatically plays

## Features

* **Peer-to-Peer Networking:** Hosted locally by the room creator using WebRTC (PeerJS).
* **Firewall Bypass:** Utilizes Google STUN and OpenRelay TURN servers to ensure connections succeed across strict mobile hotspots and corporate networks.
* **Anti-Cheat Architecture:** The game state is sanitized before broadcasting. Opponents' hands are hidden at the memory level to prevent cheating via the browser console.
* **Host-Controlled Seating:** In the waiting room the host sees a tick box next to every name (everyone starts ticked). Un-tick anyone, including the host, and they join the next game as a spectator; the ticked players are dealt in. Spectators stay spectators when the room returns to the lobby (shown un-ticked), so the host can tick them back in for the next game.
* **Turn Order Control:** The host can nudge anyone up or down with the arrow buttons in the waiting room. That order becomes the seating and turn order for the next game.
* **Disconnect Detection:** A player who closes their tab sends a final "leave" message to the host (with the connection-close event as a fallback). They stay listed in the waiting room, tagged `DISCONNECTED`, are never dealt in, and are dropped when the next game starts (the host can also kick them).
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