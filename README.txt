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
  statement.js     the settlement and the PDF statements (carried over, unchanged)
  store.js         one JSON document, in Google Drive or on disk
  webpush.js       the encryption behind phone notifications
  sw.js            service worker: shows notifications, puts the number on the icon
  client/          the app, in three readable pieces:
                     1-page.html  the page, the stylesheet and the card artwork
                     2-portal.js  signing in, the tables list, history, members
                     3-table.js   the table, the betting controls, drawing the screen
  index.html       built from those by build.py - this is what is served
  index.src.html   the same thing, kept beside it so a diff is readable
  drive-script.gs  paste this into Google Apps Script (unchanged from before)
  sw.js            service worker, so the portal can be kept on a home screen
  test-*.js        the tests; ./run-tests.sh [n] runs the lot n times and leaves non-zero
                   if anything failed, so a run can be trusted without reading it
  uitest.js        walks the whole portal in a real browser
  replaytest.js    plays a game out, then opens the replays as a member would
  badgetest.js     the number on the home screen icon: that it appears, and that reopening
                   the portal clears it

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
Any member can start a table, and whoever starts it runs it. Several can run at
once; the Tables screen lists them all with the format, who runs it, who is in and
how many seats are free. Starting one produces a message ready to paste into the
group chat.

Before play, anyone on the list may take a free seat. Once the game is running, a
latecomer asks and the game admin lets them in or does not. Leaving early without
forfeiting your blinds is a request too, and the game admin's call. Only he can
start the game, and he sets how many players it takes to start.

Seven seats, first come first served.

The four games
--------------
  Texas Hold'em            every hand.
  Hold'em with a variant   the button travels as usual; when it lands on the seat
                           holding the variant button, that player deals the chosen
                           variant instead, and the variant button then steps back
                           one seat, the other way round the table.
  Round of each            a full orbit of Texas, then a full orbit of the variant.
  Tournament               everybody starts on 10,000 chips at 50/100, the blinds
                           double every five minutes, nobody joins late and nobody
                           buys more. The last player holding the lot wins.

The variants to choose from: 4-card Omaha, 5-card Omaha, 2-card bomb pot, 5-card
bomb pot with two flops, 5-card bomb pot with three flops.

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

Records
-------
When a game ends the portal works out everyone's account, says who pays who, and
files it with the date and time. Members see the games they played in; the portal
admin sees them all. Each one downloads as a PDF.

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
  PUSH_CONTACT       The address sent to Apple and Google with every notification, so they
                     have somebody to reach about a misbehaving sender. Left unset the
                     portal's own https address is used, which is what Render gives it.
                     Only worth setting if a push service ever asks for an email instead.
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
