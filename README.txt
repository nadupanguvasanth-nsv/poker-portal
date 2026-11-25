SMART BUDDIES — a private poker portal for one group of friends
===============================================================

Built fresh. The old portal grew by accretion over many rounds of changes and the
screens showed it; this is the same idea, laid out again from the ground up.

What is in here
---------------
  server.js        the outside: web server, live feed to each phone, the clock
  portal.js        the members, and how they sign in
  lobby.js         the tables: who runs each one, who is in it, who is asking
  games.js         the four formats and the two buttons
  engine.js        the cards: shuffling, betting, who wins (carried over, unchanged)
  statement.js     pairing losers with winners, and the PDF statement for a night
  house.js         the portal's own figures - the notice before a table deals, the rounding
                   step, the flag hours - in one place, because the server enforces them and
                   the rules sheet states them and the two must not drift apart
  store.js         one JSON document, in Google Drive or on disk
  webpush.js       the encryption behind phone notifications
  sw.js            service worker: shows notifications, puts the number on the icon
  client/          the app, in three readable pieces:
                     1-page.html  the page, the stylesheet and the card artwork
                     2-portal.js  signing in, the tables list, history, members
                     3-table.js   the table, the betting controls, drawing the screen
  index.html       built from those by build.py - this is what is served
  drive-script.gs  paste this into Google Apps Script (unchanged from before)
  test-*.js        the tests; ./run-tests.sh [n] runs the lot n times and leaves non-zero
                   if anything failed, so a run can be trusted without reading it
  uitest.js        walks the whole portal in a real browser
  replaytest.js    plays a game out, then opens the replays as a member would
  badgetest.js     the number on the home screen icon: that it appears, and that reopening
                   the portal clears it
  tourneytest.js   setting the tournament chips: what the form says it will be, and what
                   the table, the blinds and the invite turn out to be
  timertest.js     the turn clock: that the ring actually runs down, warns, and moves on
  cardsizetest.js  that every card size the code asks for has a rule behind it
  livetest.js      following a hand: the move flashing on whoever made it, Folded staying
                   put, the sound, and walking into a room to watch before taking a seat
  pausetest.js     pausing and starting again, who may close a game, and a table that
                   nobody ever got going closing itself
  buyintest.js     buying more chips during a hand and between them, and buying back in
  staytest.js      the minimum time at a table, and the three ways out of it
  rulestest.js     that the house rules state the table's own numbers, not assumed ones
  bettest.js       the bet sizing buttons: distinct, climbing, and inside what is allowed
  chiptest.js      chips flying from the player who paid them to the pot
  historytest.js   searching the records and removing a game from them
  skytest.js       the celebration: that something is actually drawn, survives a redraw,
                   and clears itself up afterwards
  starttest.js     the table starting itself once enough are seated, and what happens when
                   somebody stands up again before it does
  saytest.js       the preset messages: that they reach the right person, hang on the
                   screen and go, and that the ones which act actually act
  paytest.js       settling up: who may say what, the flags that follow from not paying,
                   and the portal admin entering a receipt for somebody unreachable
  accounttest.js   the account statement: the rounding tallying to the chip, the night
                   recorded hand by hand, and what a member is shown of his own games
  bookstest.js     the portal admin's books: the standings summed a second way and held
                   against the screen, and that no ordinary member can see them
  bombtest.js      three flops settled on points, with the hands dealt by hand so the
                   answers are known before the engine is asked
  decktest.js      that every game deals out to the river at a full table of seven without
                   running out of cards, and that the burn gives way before the board does
  tiertest.js      primary and secondary members, and the message that opens the portal
  felttest.js      that every table theme keeps the writing on it readable, measured

How people get in
-----------------
You set the portal up once: open it, choose "Setting the portal up for the first
time?", and prove it is you with the storage secret (the same phrase as
DRIVE_SECRET). Give your name, your mobile number and a 4-digit passcode. You are
now the first member and the portal admin.

Everyone else you add by name and mobile number. Tap "Send link" beside their name
for a message telling them where the portal is, to put it on their home screen, and
to sign in with that number. The first time they sign in they choose their own
4-digit passcode. Five wrong tries pauses that account for five minutes.

Running a game
--------------
Members are primary or secondary. A primary member can start a table; everybody else
plays in them. Everybody begins secondary - the people already on the list included -
and the portal admin sets who is which on the Members screen, where each name carries a
chip to tap. Nobody is primary by accident: starting a game is given, not held unless
somebody remembers to take it away. The portal admin is always primary and cannot make
himself otherwise, or there would be nobody left who could open a table. Changing
somebody's standing tells them, so nobody finds out by being refused.

Share the portal with the group, on the Members screen, writes the message that opens the
portal: where it is, how to get in, and the names of everybody who can start a game. The
names come from the list at the moment it is asked for, so set people first, then send it.

A primary member can start a table, and whoever starts it runs it. Several can run at
once; the Tables screen lists them all with the format, who runs it, who is in and
how many seats are free. Starting one produces a message ready to paste into the
group chat.

Before play, anyone on the list may take a free seat. The game starts itself once
enough of them are sitting there - four unless whoever opened the table said
otherwise - after a few seconds' notice on the table, so nobody has to be chased
for a tap. If somebody stands up again in those few seconds the countdown stops and
the table says why, rather than going quiet.

Once the game is running, a latecomer asks and the game admin lets them in or does
not. The minimum time at the table runs from when each person sat down, so somebody
who arrives at midnight is not held to a clock that started at nine. Leaving early
without forfeiting your blinds is a request too, and the game admin's call.

Seven seats, first come first served.

The four games
--------------
  Texas Hold'em            every hand.
  Hold'em with a variant   the button travels as usual; when it lands on the seat
                           holding the variant button, that player deals the chosen
                           variant instead, and the variant button then steps back
                           one seat, the other way round the table.
  Round of each            a full orbit of Texas, then a full orbit of the variant.
  Tournament               whoever starts it sets the chips everyone begins with, in
                           tens of thousands, and how often the blinds double. The
                           blinds follow from the chips: everybody starts two hundred
                           big blinds deep, so 10,000 opens at 25/50 and 100,000 at
                           250/500. Nobody joins late and nobody buys more. The last
                           player holding the lot wins.

The variants to choose from: 4-card Omaha, 5-card Omaha, 2-card bomb pot, 5-card
bomb pot with two flops, 5-card bomb pot with three flops.

Three flops are settled on points, and nothing else is. Each board is worth a point, a split
board a share of one, and whoever ends with the most points takes the whole pot - so you have to
be good on two of the three, and winning one board while somebody else wins the other two is
worth nothing. Level at the top and the pot splits between those who are level. Where somebody
is all-in short, the points are counted again for the side pot among only the players who paid
into it: his cards have no claim on money he did not put in. Two flops are still paid out board
by board, half the pot each, and so is running it twice - that is one hand dealt more than once
to cut the luck, and folding points into it would quietly make it winner-takes-all.

Seven players in a 5-card game with three flops is 35 cards in hands and 15 on the boards, which
is 50 of the 52. The burn is a courtesy and the board is not, so when the deck is tight the burn
is skipped rather than a board going short - and if even that will not do, the hand stops and
says so rather than dealing a card that is not a card.

Exactly two of your cards play in every Omaha game, which cuts both ways. One in your hand with
three on the board is four of a kind - your card and one other, with the three from the board.
But four of a kind lying on the board is only three of a kind to you, because you may take three
board cards and no more, so a pocket pair there is a full house and takes it. The same board in
Texas is quads for everybody, and the fifth card decides it.

Being told when a table is up
-----------------------------
Each member turns this on for themselves, under Me. Their phone is told when somebody
starts a table, when anyone asks to join a table they are running, and when they are
let into one. The home screen icon carries a number until they open the portal.

On an iPhone this only works once the portal is on the home screen: Share, then Add to
Home Screen, then open it from there. A Safari bookmark will not do. The Me screen says
so when it sees an iPhone that has not done it. Android needs no such thing.

The number goes from the icon as soon as the portal comes back to the front. A phone does
not reload an app kept on the home screen - it hands the page back exactly as it was - so
the portal watches for coming back rather than waiting for a fresh start. It brings the
live feed up again at the same time, since that does not survive being put away either,
and without it a table would sit frozen on whatever it last showed.

Apple refuses a push outright if the portal names a contact address it does not believe in,
which is why the address sent with every push is the portal's own, or whatever PUSH_CONTACT
is set to. Render's log carries a line for every push: who it went to, who was skipped and
why, and the push service's own words if it refused.

Push is a nudge, not a promise - phones delay and drop them on battery saver - so the
group message is still the way to get everybody to a table.

Saying something
----------------
Nobody types at the table. There is a list of things worth saying and you tap one:
a player can ask for a moment, say he is in for one more hand, ask to leave early,
buy back in, sit out or come back; whoever runs the table can call people back, ask
somebody to hurry, say a break is coming or that these are the last hands. What you
tap lands at the bottom of the other person's screen, above his buttons, and goes
again after five seconds - the one place he is already looking, and gone before it
is in his way.

Some of them do more than talk. Asking to leave early raises the real request with
the game admin; buying back in, sitting out and coming back do the thing itself. One
tap, the thing happens, and everybody sees it was asked for. Free text went because
in a game on a phone it was always slower than the thing it was asking for.

At the table
------------
The player to act has his circle run down as a ring, which turns red and counts out the last
seconds. Whoever has just moved is flashed on his seat - CALL, RAISE, BET, CHECK, ALL IN - for
about a second; a player who folds is marked Folded and stays marked until the hand is over.

Sound is on to begin with. The speaker on the table itself turns it off and on - it is the one
setting people reach for in the middle of a hand - and it is remembered on that phone. A bell, two notes, means it is your turn and nothing else; everybody else's turn is a
tick, and chips going in are a click. The tones are made on the phone rather than fetched, so
there is nothing to download and nothing to fail. A phone will not make a sound until the person
has touched the screen, so the first tap of a session opens the audio.

Cards somebody turns over are drawn as large as the seat they belong to can take - the seats
along the top have only the gap to the bar above them, the rest have the whole felt - and a little
brighter than a card in the hand, with a hard edge and a shadow so they read against the green. A
player who folded is dimmed, but the card he chose to show is not: that card is the whole reason
he showed it.

Chips that go in travel: a blind, a call, a raise or an ante sends a chip from that player's seat
to the pot with the amount under it, so the money can be followed without reading the log. The
flight is a CSS animation with a negative delay, the same trick the thrown bombs use, so the table
redrawing mid-flight - which it does every time anybody acts - picks it up where it had got to
rather than starting it again.

The cloth comes in three: Emerald, Midnight and Claret, in the table menu, remembered
on that phone. All three were measured rather than eyed - the pot, the names and the
stacks have to stand out against the cloth they sit on, and a colour that looked
handsome and read badly was dropped for failing that test.

A hand worth looking up from your phone for - quads, a straight flush, or a pot four times the
usual - puts fireworks over the table, names the hand and says who took it. An ordinary pot does
not set them off, or they would stop meaning anything.

Showing your cards can be chosen at any point in the hand but is only carried out when the hand
is over. Your own screen shows what you have marked; nothing reaches the rest of the table before
the last bet is in, or the choice would be worth money to everybody else.

Any member can go into a running table and watch without taking a seat: Watch, on the table in
the list. A watcher has no seat and no chips, sees nobody's cards, and is offered a seat from
inside the room - straight away if one is free, or as a request to whoever runs the table once
the game has started.

Stopping and wrapping up
------------------------
Whoever opened a table runs it, and the portal admin can do anything he can: let people in, pause
it, close it. Nobody else can.

Pausing stops the clock and holds the next hand, so the table can break for food without anybody
being folded for being slow. Starting again hands whoever was to act a full turn, not the few
seconds that happened to be left when it stopped.

Closing a table never cuts a hand short. If one is being played it is played out first and the
game closes when it ends; the chips in the middle belong to that hand and whoever is in it deserves
to see it through. Whoever runs the table can also call the last five or ten hands, or set a time
to finish, at any point during the game - everybody then sees how long is left at the top of the
table. When the time comes round the hand being played is still played out.

A table that is opened and never started closes itself after thirty minutes (OPEN_MINUTES), so a
game nobody turned up for does not sit in everyone's list for days. A paused table is left alone,
and so is one being played, however long ago it opened.

Closing a game where no hand was ever dealt writes nothing into the records: everybody still holds
what they bought in with, and a settlement of all zeroes only buries the real games.

The games themselves are written out too - How the games go, on the Tables screen - with what
each one deals, which of your cards play, whether it is no-limit or pot-limit, and what beats
what. Like the table rules, it is generated from the specification the dealer deals by.

A pot raise is the call plus the pot as it stands after that call, not the figure showing in the
middle: 300 in the pot with 200 to call is a raise to 700. The sizing buttons work that out, and
in pot-limit the pot is the ceiling, so there is no separate all-in button.

The house rules
---------------
Every table carries its own rules sheet - the (i) beside it in the list, or House rules in the
table menu. It states the buy-in, the blinds, how long everybody is expected to stay and what the
ways out are, the seats, the clock, how the variant comes round, and who runs it. Every figure on
it is read from that table's settings as the game is being played, so it cannot drift from what
is actually happening: there is nothing to keep up to date by hand.

Chips, and leaving
------------------
Nobody is capped unless whoever opens the table says so: set maxBuyin to put a ceiling on it,
otherwise people buy in for what they like. A ceiling nobody chose is worse than none, because it
sits there unseen until it refuses somebody. A tournament caps everyone at its own stack.

Buying more chips never lands in the middle of a hand. A hand in progress is played on its own
copy of everybody's stack and writes that copy back when it ends, so chips added underneath it
were wiped the moment the hand settled while the buy-in still counted against the player - they
wait, and go on when the hand is over. A player can also ask to be bought back in automatically:
run out, and the buy-in the game was opened with goes on at the end of that hand. Until he has
chips he is simply dealt out.

Whoever opens a table says how long everybody is expected to stay, so a game does not fall apart
the moment somebody is ahead. Three ways out before that: he has lost the lot and has nothing to
stay for, the game admin lets him go, or he sits in the ring paying his blinds - posted, folded,
never dealt - until his time is up, and then leaves with what is left. Once the time is served
nobody has to ask anybody. Set it to 0 for no minimum.

Records
-------
The best hands of each game are kept to watch again. Ten of them: the biggest pots, and any hand
won with quads or a straight flush, which earns its place whatever it won - the hand people still
talk about is not always the one that moved the most chips. The rare ones take at most half the
slots so one freak hand cannot crowd out the night's real pots.

The records can be searched by what was played, by who played in it, or by the dates it falls
between.

The portal admin gets THE BOOKS above that list: every member across the games being shown, with
games played, total in, total out, net, best and worst night and what they still owe, over a
header line of games, hands dealt, chips bought in and how much is outstanding. The same search
drives it, so a name gives that player's record and a date range gives how that month went. At
the bottom is the figure that proves the rest: wins and losses must cancel to exactly nothing
across any set of games, and if they ever do not it says so in red rather than showing numbers
that are quietly wrong. Members do not see it - a private game should not show everybody the
group's standings. The portal admin, and only he, can remove a game from the records - trial games and
nights that went wrong should not sit there for ever - and it goes for everybody who played in it.

When a game ends the portal works out everyone's account, says who pays who, and
files it with the date and time. A member sees the games he played in and nobody
else's; the portal admin sees them all. Each one downloads as a PDF.

Open a game and you get your own statement for that night: what you bought in for,
what you finished with, whether you are up or down, and who you pay or collect from.
Under it, everybody's chips hand by hand with your own line picked out in gold, so
you can see where the night turned. On the Me screen, your running total across every
game you have played, which is the only figure that really answers how it is going.

Stacks are settled in fifties. Nobody wants to be told they owe 11,663. Rounding each
stack on its own does not keep the total - three stacks each rounding up invent 150
chips out of nothing - so whatever the rounding makes or loses goes onto the biggest
stack: one named person, the smallest distortion, and the books tally to the chip.
Set ROUND_TO to change the step.

Settling up
-----------
The portal pairs the biggest loser with the biggest winner until everybody is square,
so four people owe two payments rather than six.

A debt is settled when the person owed says the money arrived, and not before. The
payer can say he has paid and it is recorded, but it is a claim, not a receipt: in a
group where everybody knows everybody, the winner's word is the only thing worth
treating as true. If the money has gone and the winner has not marked it, chasing him
for it is the loser's job, and the flag stands until he does.

Anyone owing or owed is asked about it when they next open the portal, so it is not
something anybody has to remember to go and look for.

Two days unconfirmed and the person owing is flagged yellow. A yellow flag clears
itself the moment the winner confirms - nobody lifts it - and until then he can still
play, if the game admin lets him in: taking a free seat becomes a request, and the
request says he owes from a previous game.

Three debts open at once, or four days on any one of them, turns it red. Red is not a
seat he has to ask for - it keeps him out of the table altogether, playing or watching.
Only the portal admin lifts a red flag, and paying up does not lift it by itself: the
debt is settled, the flag stays until he says so. The thresholds are YELLOW_AFTER_MS,
RED_AFTER_MS and RED_AT_DEBTS.

If a winner cannot be reached, the portal admin can enter the receipt for him. That is
entering the winner's confirmation on his behalf, not lifting a flag, and it is written
down as that: who entered it, when, and that it was on somebody's behalf.

Running it
----------
  npm start                   (node server.js)

Environment:
  DRIVE_SCRIPT_URL   your Apps Script web app address. Without it the portal keeps
                     its data in a local file, which is how the tests run.
  DRIVE_SECRET       the secret in that script. It doubles as the setup secret for
                     your first sign-in.
  PUBLIC_URL         the address to put in the invite message. Render sets
                     RENDER_EXTERNAL_URL, which is used if this is not set.
  PORT               Render sets this.
  OPEN_MINUTES       How long a table may sit without anybody starting it before it closes
                     itself. Thirty minutes unless set.
  PUSH_CONTACT       The address sent to Apple and Google with every notification, so they
                     have somebody to reach about a misbehaving sender. Left unset the
                     portal's own https address is used, which is what Render gives it.
                     Only worth setting if a push service ever asks for an email instead.
  SETUP_SECRET       An alternative to DRIVE_SECRET for the one first-time setup, if you
                     would rather not type the storage secret into a phone. Either one
                     gets you in; after that it is your passcode.
  START_GRACE_MS     How much notice the table gives before dealing itself once enough
                     people are sitting there. Six seconds unless set.
  ROUND_TO           The step the final stacks are rounded to when the accounts are
                     worked out. Fifty unless set.
  YELLOW_AFTER_MS    How long a debt may sit unconfirmed before the person owing is
                     flagged yellow. Two days unless set.
  RED_AFTER_MS       How long before it turns red. Four days unless set.
  RED_AT_DEBTS       How many debts open at once turns it red regardless of their age.
                     Three unless set.
  FRESH_START        Set it to 1 for one start only, to begin with an empty portal and
                     write over whatever the old portal left in the file. Take it off
                     again once you have set yourself up: left on, every restart wipes
                     the portal. Only needed when moving over from the old build.

Nothing on a table ever waits for a tap that never comes. A player who runs out of
time checks or folds and is sat out; if everybody is all-in and the table is voting
on running the board twice, the vote has twenty seconds and a silence means once.

Worth knowing: /ping answers "ok" for UptimeRobot. After the service sleeps and
wakes, a game that was in progress comes back waiting rather than playing - the
interrupted hand is cancelled, everyone keeps the chips they had before it, and
whoever runs the table taps Start to carry on.
