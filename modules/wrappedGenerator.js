/*
 * File: wrappedGenerator.js
 * Project: valhalla-updater
 * File Created: Sunday, 22nd December 2024
 * Author: Valhalla Team
 * -----
 * Generates fun and informative Wrapped summaries from player statistics
 * Consolidated single-embed design with scaled absurd comparisons
 */

const { EmbedBuilder } = require('discord.js');
// ============================================================================
// SCALED COMPARISON MESSAGES - Ultra-Granular Edition
// ============================================================================

// Distance comparisons (in km) - Maximum granularity pattern: 0-10, then 15-50 by 5s, 60-100 by 10s, etc.
const DISTANCE_TIERS = [
    { threshold: 0, text: "Zero movement. Are you a statue? A really dedicated one?" },
    { threshold: 1, text: "1km! You moved! The sun rises on a new era!" },
    { threshold: 2, text: "2km. Twice the ambition of last tier." },
    { threshold: 3, text: "3km. Three's company, and you're it." },
    { threshold: 4, text: "4km. The floor is lava, but you survived." },
    { threshold: 5, text: "5km. A nice walk to the neighbor's base." },
    { threshold: 6, text: "6km. Six is afraid of you now." },
    { threshold: 7, text: "7km. Lucky number seven! Unlucky for the mobs." },
    { threshold: 8, text: "8km. You're octo-motivated!" },
    { threshold: 9, text: "9km. Almost double digits! The anticipation!" },
    { threshold: 10, text: "10km! Double digits! The city fears you." },
    { threshold: 15, text: "15km. You've seen things. Terrible things." },
    { threshold: 20, text: "20km. The render distance can't keep up." },
    { threshold: 25, text: "25km. Quarter-marathon! Your legs are meta." },
    { threshold: 30, text: "30km. You've walked to the edge of reason." },
    { threshold: 35, text: "35km. The chunks load in your wake." },
    { threshold: 40, text: "40km. Life begins at 40... km from spawn." },
    { threshold: 45, text: "45km. Halfway to somewhere important!" },
    { threshold: 50, text: "50km. Ultra-marathoner of the blocky world!" },
    { threshold: 60, text: "60km. You've crossed biomes like they're doorways." },
    { threshold: 70, text: "70km. The world generator is sweating." },
    { threshold: 80, text: "80km. Around the world in 80km? Almost." },
    { threshold: 90, text: "90km. Ninety problems but distance ain't one." },
    { threshold: 100, text: "100km! Centurion status! The map needs more paper." },
    { threshold: 150, text: "150km. You've outrun your own shadow." },
    { threshold: 200, text: "200km. Two centuries of pure movement." },
    { threshold: 250, text: "250km. The server host is considering a bigger SSD." },
    { threshold: 300, text: "300km. You've worn out three pairs of diamond boots." },
    { threshold: 350, text: "350km. The terrain generation is giving up." },
    { threshold: 400, text: "400km. Four hundred units of pure dedication." },
    { threshold: 450, text: "450km. Half a thousand! The milestone looms!" },
    { threshold: 500, text: "500km! Half a thousand! The world bends to you." },
    { threshold: 600, text: "600km. Six hundred reasons to get new boots." },
    { threshold: 700, text: "700km. Lucky seven hundred! Unlucky for the world border." },
    { threshold: 800, text: "800km. You're 80% of the way to a thousand. Math!" },
    { threshold: 900, text: "900km. So close to four digits you can taste it." },
    { threshold: 1000, text: "1000km! ONE THOUSAND! London to Rome, baby!" },
    { threshold: 1500, text: "1500km. You've walked to the moon's parking orbit." },
    { threshold: 2000, text: "2000km. Two thousand clicks of pure blocky fury." },
    { threshold: 2500, text: "2500km. The world file is just your footsteps." },
    { threshold: 3000, text: "3000km. You've explored every biome. Twice." },
    { threshold: 3500, text: "3500km. The world border is getting nervous." },
    { threshold: 4000, text: "4000km. Four thousand. The number is meaningless now." },
    { threshold: 4500, text: "4500km. You're not lost, the world is lost." },
    { threshold: 5000, text: "5000km! You could've crossed the USA! Twice!" },
    { threshold: 6000, text: "6000km. The server is just your personal treadmill." },
    { threshold: 7000, text: "7000km. Seven thousand. The number haunts you." },
    { threshold: 8000, text: "8000km. You've walked to the center of the Earth. Twice." },
    { threshold: 9000, text: "9000km. IT'S OVER NINE THOUSAND! (Had to be done)" },
    { threshold: 10000, text: "10000km! New York to Tokyo (with creative swimming)!" },
    { threshold: 15000, text: "15000km. You've walked to the moon's moon." },
    { threshold: 20000, text: "20000km. Twenty thousand leagues under the... wait, wrong unit." },
    { threshold: 25000, text: "25000km. The equator is jealous." },
    { threshold: 30000, text: "30000km. You've circled the Earth. For fun." },
    { threshold: 35000, text: "35000km. The world is your oval track." },
    { threshold: 40000, text: "40000km. Circumnavigation is a daily routine." },
    { threshold: 45000, text: "45000km. You've walked to the moon and halfway back." },
    { threshold: 50000, text: "50000km. You've walked to Mars. Almost." },
    { threshold: 60000, text: "60000km. Sixty thousand. The number is now a lifestyle." },
    { threshold: 70000, text: "70000km. You've walked to the moon twice. Showoff." },
    { threshold: 80000, text: "80000km. The world border moved to get away from you." },
    { threshold: 90000, text: "90000km. Ninety thousand. Time has lost meaning." },
    { threshold: 100000, text: "100000km! 2.5x around Earth! Restless doesn't cover it." },
    { threshold: 150000, text: "150000km. You've walked to the Sun. Almost. Not really." },
    { threshold: 200000, text: "200000km. Two hundred thousand. The void calls." },
    { threshold: 250000, text: "250000km. Quarter-million club! Exclusive!" },
    { threshold: 300000, text: "300000km. You've walked to the moon eight times. Why?" },
    { threshold: 350000, text: "350000km. The moon is considering a restraining order." },
    { threshold: 384400, text: "384400km! YOU WALKED TO THE MOON! HOUSTON, WE HAVE A GAMER!" },
    { threshold: 400000, text: "400000km. You've walked to the moon and then some." },
    { threshold: 450000, text: "450000km. The moon is your backyard." },
    { threshold: 500000, text: "500000km. Half a million. The cosmos trembles." },
    { threshold: 600000, text: "600000km. You've walked to the moon and back. Again." },
    { threshold: 700000, text: "700000km. Seven hundred thousand. The universe is small." },
    { threshold: 768800, text: "768800km! TO THE MOON AND BACK! NASA WANTS YOUR AUTOGRAPH!" },
    { threshold: 800000, text: "800000km. The moon is just a pit stop." },
    { threshold: 900000, text: "900000km. Nine hundred thousand. Reality is optional." },
    { threshold: 1000000, text: "1 MILLION KM! You're approaching Venus orbit. Pack sunscreen." },
    { threshold: 1500000, text: "1.5M km. Venus is jealous of your dedication." },
    { threshold: 2000000, text: "2M km. Two million. The solar system is your playground." },
    { threshold: 2500000, text: "2.5M km. Mars is getting nervous." },
    { threshold: 3000000, text: "3M km. Three million. The asteroid belt waves." },
    { threshold: 3500000, text: "3.5M km. You've walked to Mars. Twice." },
    { threshold: 4000000, text: "4M km. The Red Planet is your second home." },
    { threshold: 4500000, text: "4.5M km. Jupiter's moons are watching." },
    { threshold: 5000000, text: "5M km. You've destabilized the inner solar system." },
    { threshold: 54600000, text: "54.6M km! YOU REACHED MARS! PACK YOUR BAGS, ELON IS JEALOUS!" },
    { threshold: 100000000, text: "100M km. The Sun is your next target." },
    { threshold: 150000000, text: "150M km! YOU MADE IT TO THE SUN! HOPE YOU WORE SPF 1,000,000!" },
    { threshold: 1000000000, text: "1 BILLION KM! You're past Jupiter. The gas giants salute you." },
    { threshold: 4500000000, text: "4.5B km! CONGRATS, YOU LEFT THE SOLAR SYSTEM! ALIENS ARE CONFUSED!" },
    { threshold: 9460730472580, text: "1 LIGHT-YEAR! TIME DILATION APPLIES. YOU'VE WON MINECRAFT FOREVER!" },
];

// Homes/SetHomes comparisons - NEW TIER ARRAY
const HOMES_TIERS = [
    { threshold: 0, text: "No homes set. A true wanderer. The world is your bed." },
    { threshold: 1, text: "1 home. A humble abode. Your spawn point is set." },
    { threshold: 2, text: "2 homes. Twice the comfort!" },
    { threshold: 3, text: "3 homes. A nice little triangle of safety!" },
    { threshold: 4, text: "4 homes. A square of security!" },
    { threshold: 5, text: "5 homes. Penta-properties! You're a landlord!" },
    { threshold: 6, text: "6 homes. Hexa-houses! You're a real estate mogul!" },
    { threshold: 7, text: "7 homes. Lucky number seven! The beds are made." },
    { threshold: 8, text: "8 homes. Octo-dwellings! You're a housing developer!" },
    { threshold: 9, text: "9 homes. Almost double digits! The property empire looms!" },
    { threshold: 10, text: "10 homes! Double digits! You're a property tycoon!" },
    { threshold: 15, text: "15 homes. The beds are warm. The chests are full." },
    { threshold: 20, text: "20 homes. A housing empire! You're a CEO." },
    { threshold: 25, text: "25 homes. Quarter-hundred properties! The market is yours." },
    { threshold: 30, text: "30 homes. A real estate dynasty!" },
    { threshold: 35, text: "35 homes. The beds are calling. All of them." },
    { threshold: 40, text: "40 homes. Quadraginta dwellings! You're a legend." },
    { threshold: 45, text: "45 homes. Almost fifty! The property market is yours." },
    { threshold: 50, text: "50 homes! Half a hundred! You're a housing market crash waiting to happen." },
    { threshold: 60, text: "60 homes. Sexaginta properties! You're a dimension-hopper!" },
    { threshold: 70, text: "70 homes. The beds are everywhere. You can't escape them." },
    { threshold: 80, text: "80 homes. Octoginta dwellings! You're a cosmic landlord!" },
    { threshold: 90, text: "90 homes. Almost a hundred! The property empire is cosmic." },
    { threshold: 100, text: "100 homes! Centurion status! You're a walking hotel chain!" },
    { threshold: 150, text: "150 homes. The beds are a blur. You sleep everywhere." },
    { threshold: 200, text: "200 homes. Duocentury properties! You're a housing deity!" },
    { threshold: 250, text: "250 homes. Quarter-thousand beds! Sleep is your superpower." },
    { threshold: 300, text: "300 homes. A bed in every chunk!" },
    { threshold: 350, text: "350 homes. The beds are multiplying. You're not sure how." },
    { threshold: 400, text: "400 homes. Quadricentury dwellings! You're a sleep god!" },
    { threshold: 450, text: "450 homes. Almost five hundred! The beds are infinite." },
    { threshold: 500, text: "500 homes! Half a thousand! You're a walking city of beds!" },
    { threshold: 600, text: "600 homes. Sexacentury properties! You're a dimension of beds!" },
    { threshold: 700, text: "700 homes. The beds are a universe. You're the sleeper." },
    { threshold: 800, text: "800 homes. Octocentury dwellings! You're a cosmic sleep entity!" },
    { threshold: 900, text: "900 homes. Almost a thousand! The beds are a multiverse." },
    { threshold: 1000, text: "1000 homes! A millenary of mattresses! You're the god of spawn points!" },
];

// Playtime comparisons (in hours) - Revised for maximum granularity
const PLAYTIME_TIERS = [
    { threshold: 0, text: "Fresh player! Welcome! The adventure begins!" },
    { threshold: 1, text: "1 hour in. Just getting started. The hook is set." },
    { threshold: 2, text: "2 hours. A solid session!" },
    { threshold: 3, text: "3 hours. A good afternoon!" },
    { threshold: 4, text: "4 hours. A quarter of a day! Time flies!" },
    { threshold: 5, text: "5 hours. A solid chunk of time!" },
    { threshold: 6, text: "6 hours. The sun is setting. On your free time." },
    { threshold: 7, text: "7 hours. A full work day! Of Minecraft." },
    { threshold: 8, text: "8 hours. A full shift! You're employed now." },
    { threshold: 9, text: "9 hours. Nine is fine! The addiction is real." },
    { threshold: 10, text: "10 hours! You're hooked, aren't you? Admit it." },
    { threshold: 15, text: "15 hours. The day is gone. You don't care." },
    { threshold: 20, text: "20 hours. Almost a full day! The dedication is real." },
    { threshold: 25, text: "25 hours. Over a day! Time is a construct." },
    { threshold: 30, text: "30 hours. More than a day! Reality is optional." },
    { threshold: 35, text: "35 hours. The weekend is gone. You don't care." },
    { threshold: 40, text: "40 hours. A full work week! Of Minecraft." },
    { threshold: 45, text: "45 hours. The week is young. You're not." },
    { threshold: 50, text: "50 hours of dedication! That's two days! Almost." },
    { threshold: 60, text: "60 hours. Two and a half days! The grind is real." },
    { threshold: 70, text: "70 hours. Almost three days! Sleep is for the weak." },
    { threshold: 80, text: "80 hours. Over three days! You're a machine." },
    { threshold: 90, text: "90 hours. Almost four days! The machine is overheating." },
    { threshold: 100, text: "100 hours. That's 4+ days of pure Minecraft! You're committed." },
    { threshold: 150, text: "150 hours. Over a week! The dedication is legendary." },
    { threshold: 200, text: "200 hours. Over a week! You're a legend." },
    { threshold: 250, text: "250 hours. Over 10 days of your life! Well spent." },
    { threshold: 300, text: "300 hours. Almost two weeks! The addiction is strong." },
    { threshold: 350, text: "350 hours. Two weeks! The world is still spinning. You're not." },
    { threshold: 400, text: "400 hours. Over two weeks! You're a master." },
    { threshold: 450, text: "450 hours. Almost three weeks! The dedication is unmatched." },
    { threshold: 500, text: "500 hours. You could've learned a new language. But you chose Minecraft." },
    { threshold: 600, text: "600 hours. 25 days! The month is gone." },
    { threshold: 700, text: "700 hours. Almost a month! You're a veteran." },
    { threshold: 800, text: "800 hours. Over a month! The dedication is cosmic." },
    { threshold: 900, text: "900 hours. Almost 38 days! You're a myth." },
    { threshold: 1000, text: "1000 hours! 41 days of Minecraft. You're a legend." },
    { threshold: 1500, text: "1500 hours. Over 60 days! You're a titan." },
    { threshold: 2000, text: "2000 hours. 83 days! Minecraft is your second job." },
    { threshold: 2500, text: "2500 hours. Over 100 days! You're a master." },
    { threshold: 3000, text: "3000 hours. 125 days! The dedication is supernatural." },
    { threshold: 3500, text: "3500 hours. Almost 150 days! You're a cosmic entity." },
    { threshold: 4000, text: "4000 hours. Over 150 days! Time is a flat circle." },
    { threshold: 4500, text: "4500 hours. Almost 200 days! The dedication is infinite." },
    { threshold: 5000, text: "5000 hours! 208 days total. Absolute dedication." },
    { threshold: 6000, text: "6000 hours. 250 days! The year is young." },
    { threshold: 7000, text: "7000 hours. Almost 300 days! You're a legend." },
    { threshold: 8000, text: "8000 hours. Over 300 days! The dedication is eternal." },
    { threshold: 9000, text: "9000 hours. Almost a year! You're a myth." },
    { threshold: 10000, text: "10000 hours. You're a certified Minecraft master. A PhD in blocks." },
    { threshold: 15000, text: "15000 hours. Over 600 days! You're a cosmic entity." },
    { threshold: 20000, text: "20000 hours. 833 days! Minecraft is your first job." },
    { threshold: 25000, text: "25000 hours! Almost 3 years of continuous play! Time works differently for you." },
    { threshold: 30000, text: "30000 hours. Over 3 years! You're a cosmic entity." },
    { threshold: 35000, text: "35000 hours. Almost 4 years! The dedication is eternal." },
    { threshold: 40000, text: "40000 hours. Over 4 years! You're a legend." },
    { threshold: 45000, text: "45000 hours. Almost 5 years! Time is a suggestion." },
    { threshold: 50000, text: "50000 hours! 5+ years! Time works differently for you. You've ascended." },
];

// Death comparisons - from immortal to professional respawner
const DEATH_TIERS = [
    { threshold: 0, text: "Zero deaths. Are you even playing, or just spectating perfection?" },
    { threshold: 1, text: "1 death. We've all been there. Welcome to mortality." },
    { threshold: 2, text: "2 deaths. Twice the learning!" },
    { threshold: 3, text: "3 deaths. Third time's the charm? Not yet." },
    { threshold: 4, text: "4 deaths. Tetra-failure! But you're trying." },
    { threshold: 5, text: "5 deaths. The world is harsh sometimes." },
    { threshold: 6, text: "6 deaths. Hexa-demise! Getting a pattern here." },
    { threshold: 7, text: "7 deaths. Lucky number seven! For the mobs." },
    { threshold: 8, text: "8 deaths. Octo-casualty! The mobs are taking notes." },
    { threshold: 9, text: "9 deaths. Almost double digits! The suspense!" },
    { threshold: 10, text: "10 deaths. Double digits! You're learning through trial and error." },
    { threshold: 15, text: "15 deaths. The mobs have started a betting pool on you." },
    { threshold: 20, text: "20 deaths. Vigintuple kill! (For the mobs)" },
    { threshold: 25, text: "25 deaths. The mobs are onto you. Like, really onto you." },
    { threshold: 30, text: "30 deaths. Triginta tragedies! Latin for 'you died a lot'." },
    { threshold: 35, text: "35 deaths. The respawn button is getting warm." },
    { threshold: 40, text: "40 deaths. Quadraginta quagmires! You're persistent." },
    { threshold: 45, text: "45 deaths. The death screen is your loading screen." },
    { threshold: 50, text: "50 deaths. Respawn button knows you by name. First name basis." },
    { threshold: 60, text: "60 deaths. Sexaginta setbacks! But you persevere." },
    { threshold: 70, text: "70 deaths. The mobs have a support group about you." },
    { threshold: 80, text: "80 deaths. Octoginta obituaries! You're famous in the afterlife." },
    { threshold: 90, text: "90 deaths. The death counter is now a speedometer." },
    { threshold: 100, text: "100 deaths! That bed must be worn out. Like, structurally compromised." },
    { threshold: 150, text: "150 deaths. The Grim Reaper has you on speed dial." },
    { threshold: 200, text: "200 deaths. Duocentury demise! Two hundred trips to the void." },
    { threshold: 250, text: "250 deaths. You've died more than some games have levels." },
    { threshold: 300, text: "300 deaths. The mobs are writing a biography: 'The Human Who Wouldn't Stay Dead'." },
    { threshold: 350, text: "350 deaths. The death animation is burned into your screen." },
    { threshold: 400, text: "400 deaths. Quadricentennial killing! The mobs celebrate your anniversary." },
    { threshold: 450, text: "450 deaths. The afterlife has a frequent visitor program. You're platinum tier." },
    { threshold: 500, text: "500 deaths! That bed is more respawn point than furniture." },
    { threshold: 600, text: "600 deaths. The death sound is your notification tone." },
    { threshold: 700, text: "700 deaths. The mobs are getting tired of killing you. Almost." },
    { threshold: 800, text: "800 deaths. Octocentury obliteration! The void is your second home." },
    { threshold: 900, text: "900 deaths. Nine hundred ways to die in Minecraft. You've found them all." },
    { threshold: 1000, text: "1000 deaths! At this point, dying is your cardio. And your hobby." },
    { threshold: 1500, text: "1500 deaths. The death screen has a 'Welcome Back' message with your name." },
    { threshold: 2000, text: "2000 deaths. Duomillenary demise! Two thousand and counting." },
    { threshold: 2500, text: "2500 deaths. You've died more than some people blink in a day. Seriously." },
    { threshold: 3000, text: "3000 deaths. The mobs are considering retirement. You're too easy." },
    { threshold: 3500, text: "3500 deaths. The respawn button filed a restraining order." },
    { threshold: 4000, text: "4000 deaths. Quadromillenary massacre! The void is your address." },
    { threshold: 4500, text: "4500 deaths. The death animation is now a loading screen for your life." },
    { threshold: 5000, text: "5000 deaths! This is dedication to failure. Beautiful, beautiful failure." },
    { threshold: 6000, text: "6000 deaths. The mobs have a union. You're their main topic." },
    { threshold: 7000, text: "7000 deaths. The afterlife is considering a dedicated wing." },
    { threshold: 8000, text: "8000 deaths. Octomillenary obliteration! You're not dying, you're teleporting badly." },
    { threshold: 9000, text: "9000 deaths. IT'S OVER NINE THOUSAND! (For the mobs' kill count)" },
    { threshold: 10000, text: "10K deaths. Speedrunning death% unintentionally. WR pace." },
    { threshold: 15000, text: "15K deaths. The death counter overflowed. Twice." },
    { threshold: 20000, text: "20K deaths. The mobs have a bounty on you. For sport." },
    { threshold: 25000, text: "25K deaths. You've died more times than a hardcore world has backups." },
    { threshold: 30000, text: "30K deaths. The respawn button is now a joystick." },
    { threshold: 35000, text: "35K deaths. The afterlife has a VIP lounge. You're the only member." },
    { threshold: 40000, text: "40K deaths. The death screen is your desktop wallpaper." },
    { threshold: 45000, text: "45K deaths. The mobs are writing fanfiction about killing you." },
    { threshold: 50000, text: "50K deaths?! You should write a book: 'How to Die in Minecraft: A Comprehensive Guide'." },
    { threshold: 60000, text: "60K deaths. The death animation is smoother than your walking animation." },
    { threshold: 70000, text: "70K deaths. The void has a 'Do Not Respawn' list. You're on it. It doesn't work." },
    { threshold: 80000, text: "80K deaths. Octodecimillenary obliteration! The numbers are made up, the deaths are real." },
    { threshold: 90000, text: "90K deaths. The mobs are getting achievement notifications for killing you." },
    { threshold: 100000, text: "100K deaths. You've respawned more than some servers have total joins. Combined." },
    { threshold: 150000, text: "150K deaths. The death screen is now a loading screen for your existence." },
    { threshold: 200000, text: "200K deaths. The afterlife is considering a merger with your bedroom." },
    { threshold: 250000, text: "250K deaths. Quarter-million club! The most exclusive club no one wants to join." },
    { threshold: 300000, text: "300K deaths. The mobs have a retirement plan based on your deaths." },
    { threshold: 350000, text: "350K deaths. The respawn button is now a part of your keyboard's legend." },
    { threshold: 400000, text: "400K deaths. The death counter is now a 64-bit integer. For you." },
    { threshold: 450000, text: "450K deaths. The void is your primary residence. The overworld is vacation." },
    { threshold: 500000, text: "500K deaths. Half a million. The mobs are tired. You're not." },
    { threshold: 600000, text: "600K deaths. The death animation is now a cutscene." },
    { threshold: 700000, text: "700K deaths. The afterlife has a 'Most Valuable Customer' award. You won it." },
    { threshold: 800000, text: "800K deaths. The mobs are considering a class-action lawsuit for overwork." },
    { threshold: 900000, text: "900K deaths. Nine hundred thousand. The number is now a meme." },
    { threshold: 1000000, text: "A MILLION DEATHS. You're not dying, you're just teleporting aggressively. And often." },
];

// Kill comparisons - from pacifist to extinction event
const KILL_TIERS = [
    { threshold: 0, text: "Zero kills. A true pacifist. The mobs respect you (and live)." },
    { threshold: 1, text: "1 kill. It was self-defense. Probably." },
    { threshold: 2, text: "2 kills. Twice the justification." },
    { threshold: 3, text: "3 kills. Triple threat! The mobs are noticing." },
    { threshold: 4, text: "4 kills. Tetra-termination! You're on a list." },
    { threshold: 5, text: "5 kills. Penta-peril! The mobs are talking." },
    { threshold: 6, text: "6 kills. Hexa-homicide! Getting a reputation." },
    { threshold: 7, text: "7 kills. Lucky seven! Unlucky for them." },
    { threshold: 8, text: "8 kills. Octo-obliteration! You're a problem." },
    { threshold: 9, text: "9 kills. Nonuple neutralization! Almost double digits!" },
    { threshold: 10, text: "10 kills. Just self-defense, surely. Ten times." },
    { threshold: 15, text: "15 kills. The mobs have a wanted poster with your skin." },
    { threshold: 20, text: "20 kills. Vigintuple violence! You're a menace." },
    { threshold: 25, text: "25 kills. The mobs are learning to fear you." },
    { threshold: 30, text: "30 kills. Triginta termination! You're a legend." },
    { threshold: 35, text: "35 kills. The mobs are considering a peace treaty." },
    { threshold: 40, text: "40 kills. Quadraginta carnage! You're a one-person army." },
    { threshold: 45, text: "45 kills. The mobs have a support group. You're the topic." },
    { threshold: 50, text: "50 kills. Getting the hang of combat! And murder." },
    { threshold: 60, text: "60 kills. Sexaginta slaughter! The mobs have nightmares." },
    { threshold: 70, text: "70 kills. The mobs are writing their will before spawning." },
    { threshold: 80, text: "80 kills. Octoginta obliteration! You're a natural disaster." },
    { threshold: 90, text: "90 kills. The mobs are considering a career change." },
    { threshold: 100, text: "100 kills! The mobs have nightmares about YOU." },
    { threshold: 150, text: "150 kills. The mobs have a bounty on you. For safety." },
    { threshold: 200, text: "200 kills. Duocentury destruction! You're a war crime." },
    { threshold: 250, text: "250 kills. The mobs are evolving to avoid you." },
    { threshold: 300, text: "300 kills. The mobs have a religion. You're the devil." },
    { threshold: 350, text: "350 kills. The mobs are considering extinction." },
    { threshold: 400, text: "400 kills. Quadricentennial carnage! You're an ecosystem collapse." },
    { threshold: 450, text: "450 kills. The mobs are hiding in the void. You'd follow." },
    { threshold: 500, text: "500 kills. Local monster hunter for hire! (No refunds)" },
    { threshold: 600, text: "600 kills. The mobs are applying for endangered status." },
    { threshold: 700, text: "700 kills. The mobs have a memorial day for your victims." },
    { threshold: 800, text: "800 kills. Octocentury slaughter! You're a walking apocalypse." },
    { threshold: 900, text: "900 kills. The mobs are negotiating with Notch for a nerf." },
    { threshold: 1000, text: "1000 kills! They should rename you 'The Exterminator'." },
    { threshold: 1500, text: "1500 kills. The mobs are considering a class-action lawsuit." },
    { threshold: 2000, text: "2000 kills. Duomillenary massacre! You're a one-person extinction event." },
    { threshold: 2500, text: "2500 kills. The mobs have a museum of your victims." },
    { threshold: 3000, text: "3000 kills. The mobs are writing epic poems about you. They're tragedies." },
    { threshold: 3500, text: "3500 kills. The mobs are applying for refugee status." },
    { threshold: 4000, text: "4000 kills. Quadromillenary carnage! You're a natural disaster." },
    { threshold: 4500, text: "4500 kills. The mobs are considering moving to another game." },
    { threshold: 5000, text: "5000 kills. You're basically the Doom Slayer. In block form." },
    { threshold: 6000, text: "6000 kills. The mobs have a support hotline. You're the reason." },
    { threshold: 7000, text: "7000 kills. The mobs are getting therapy." },
    { threshold: 8000, text: "8000 kills. Octodecimillenary obliteration! The ecosystem is toast." },
    { threshold: 9000, text: "9000 kills. IT'S OVER NINE THOUSAND! (For real this time)" },
    { threshold: 10000, text: "10K kills! They should rename the game 'YouCraft' because you own it." },
    { threshold: 15000, text: "15K kills. The mobs are considering a peace treaty. You decline." },
    { threshold: 20000, text: "20K kills. The mobs are a renewable resource. You're the harvester." },
    { threshold: 25000, text: "25K kills. There's a mob support group. You're the only topic." },
    { threshold: 30000, text: "30K kills. The mobs are endangered. You're the reason." },
    { threshold: 35000, text: "35K kills. The mobs are considering mass migration. To the void." },
    { threshold: 40000, text: "40K kills. The mobs are writing their will before spawning." },
    { threshold: 45000, text: "45K kills. The mobs have a memorial fund. You're the donor." },
    { threshold: 50000, text: "50K kills. Some species are endangered now. Directly because of you." },
    { threshold: 60000, text: "60K kills. The mobs are applying for protected status." },
    { threshold: 70000, text: "70K kills. The mobs have a museum. You're the main exhibit." },
    { threshold: 80000, text: "80K kills. Octogintamillenary massacre! The ecosystem is toast." },
    { threshold: 90000, text: "90K kills. The mobs are considering a class-action lawsuit for genocide." },
    { threshold: 100000, text: "100K kills! You've caused a mass extinction event. Congratulations?" },
    { threshold: 150000, text: "150K kills. The mobs are a myth now. You killed them all." },
    { threshold: 200000, text: "200K kills. Duocentury carnage! The mobs are folklore." },
    { threshold: 250000, text: "250K kills. Quarter-million club! The mobs are history." },
    { threshold: 300000, text: "300K kills. The mobs are a memory. You're the nightmare." },
    { threshold: 350000, text: "350K kills. The mobs are extinct. You win. Everyone loses." },
    { threshold: 400000, text: "400K kills. Quadricentury slaughter! The mobs are a legend." },
    { threshold: 450000, text: "450K kills. The mobs are a cautionary tale. You're the tale." },
    { threshold: 500000, text: "500K kills. Half a million. The mobs are a statistical anomaly." },
    { threshold: 600000, text: "600K kills. The mobs are a rounding error in your kill count." },
    { threshold: 700000, text: "700K kills. The mobs are a myth parents tell their children." },
    { threshold: 800000, text: "800K kills. Octocentury carnage! The mobs are a legend." },
    { threshold: 900000, text: "900K kills. The mobs are a bedtime story. You're the monster." },
    { threshold: 1000000, text: "A MILLION KILLS. The mobs are considering a peace treaty. You're the negotiation." },
    { threshold: 1500000, text: "1.5M kills. The mobs are a memory. A bad one." },
    { threshold: 2000000, text: "2M kills. Duomillenary massacre! The mobs are a footnote." },
    { threshold: 2500000, text: "2.5M kills. The mobs are a rounding error." },
    { threshold: 3000000, text: "3M kills. The mobs are a statistical impossibility." },
    { threshold: 3500000, text: "3.5M kills. The mobs are a legend. You're the myth." },
    { threshold: 4000000, text: "4M kills. Quadromillenary carnage! The mobs are a dream." },
    { threshold: 4500000, text: "4.5M kills. The mobs are a whisper. You're a scream." },
    { threshold: 5000000, text: "5M kills. The mobs are a renewable resource. You're the harvester." },
    { threshold: 6000000, text: "6M kills. The mobs are a commodity. You're the market." },
    { threshold: 7000000, text: "7M kills. The mobs are a currency. You're the mint." },
    { threshold: 8000000, text: "8M kills. Octomillenary slaughter! The mobs are a joke." },
    { threshold: 9000000, text: "9M kills. The mobs are a myth. You're the legend." },
    { threshold: 10000000, text: "10M KILLS! At this point, mobs are a renewable resource. You're the power plant." },
];

// Block comparisons - from casual miner to planet destroyer
const BLOCK_TIERS = [
    { threshold: 0, text: "Zero blocks mined. Enjoying creative mode? Or just vibing?" },
    { threshold: 1, text: "1 block. A single, perfect block. Minimalism at its finest." },
    { threshold: 2, text: "2 blocks. Twice the minimalism!" },
    { threshold: 3, text: "3 blocks. A triangle of progress!" },
    { threshold: 4, text: "4 blocks. A square of ambition!" },
    { threshold: 5, text: "5 blocks. A pentagon of potential!" },
    { threshold: 6, text: "6 blocks. A hexagon of hope!" },
    { threshold: 7, text: "7 blocks. Lucky number seven! Unlucky for the stone." },
    { threshold: 8, text: "8 blocks. An octagon of effort!" },
    { threshold: 9, text: "9 blocks. Almost double digits! The anticipation!" },
    { threshold: 10, text: "10 blocks. Double digits! A small hole appears!" },
    { threshold: 15, text: "15 blocks. A nice little dent in the world." },
    { threshold: 20, text: "20 blocks. A cozy cave entrance!" },
    { threshold: 25, text: "25 blocks. A quarter-century of mining!" },
    { threshold: 30, text: "30 blocks. A decent starter mine." },
    { threshold: 35, text: "35 blocks. The world is starting to notice." },
    { threshold: 40, text: "40 blocks. A solid day's work!" },
    { threshold: 45, text: "45 blocks. Almost fifty! The milestone looms!" },
    { threshold: 50, text: "50 blocks. Half a hundred! You're getting somewhere!" },
    { threshold: 60, text: "60 blocks. A sexaginta of stone! Latin for 'you mined a lot'." },
    { threshold: 70, text: "70 blocks. The world is slightly less cubic." },
    { threshold: 80, text: "80 blocks. An octoginta of ore! You're a miner now." },
    { threshold: 90, text: "90 blocks. Almost a hundred! The suspense is killing the stone." },
    { threshold: 100, text: "100 blocks! A nice round number. A small hole appears!" },
    { threshold: 150, text: "150 blocks. The world is starting to feel your pick." },
    { threshold: 200, text: "200 blocks. Duocentury destruction! You've made a dent." },
    { threshold: 250, text: "250 blocks. Quarter-thousand club! Exclusive!" },
    { threshold: 300, text: "300 blocks. A decent mine shaft!" },
    { threshold: 350, text: "350 blocks. The world is considering a counter-offer." },
    { threshold: 400, text: "400 blocks. Quadricentury carnage! You're a miner!" },
    { threshold: 450, text: "450 blocks. Almost five hundred! The world trembles." },
    { threshold: 500, text: "500 blocks. Half a thousand! You've built a house!" },
    { threshold: 600, text: "600 blocks. Sexaginta destruction! The world is less blocky." },
    { threshold: 700, text: "700 blocks. The world is starting to worry." },
    { threshold: 800, text: "800 blocks. Octocentury carnage! You're a serious miner." },
    { threshold: 900, text: "900 blocks. Almost a thousand! The world is nervous." },
    { threshold: 1000, text: "1000 blocks! 1K blocks! Enough for a nice house!" },
    { threshold: 1500, text: "1500 blocks. The world is considering a lawsuit." },
    { threshold: 2000, text: "2000 blocks. Duokiloblock destruction! You've built a mansion!" },
    { threshold: 2500, text: "2500 blocks. Quarter-million-block club! Wait, no, that's 250K. You're at 2.5K." },
    { threshold: 3000, text: "3000 blocks. A small castle appears!" },
    { threshold: 3500, text: "3500 blocks. The beds are multiplying. You're not sure how." },
    { threshold: 4000, text: "4000 blocks. Quadkiloblock carnage! You're a builder!" },
    { threshold: 4500, text: "4500 blocks. Almost five thousand! The world is sweating." },
    { threshold: 5000, text: "5000 blocks. Five thousand! You've built a fortress!" },
    { threshold: 6000, text: "6000 blocks. Sexakiloblock destruction! The world is concerned." },
    { threshold: 7000, text: "7000 blocks. The world is considering a counter-attack." },
    { threshold: 8000, text: "8000 blocks. Octokiloblock carnage! You're a demolition expert." },
    { threshold: 9000, text: "9000 blocks. Almost ten thousand! The world is terrified." },
    { threshold: 10000, text: "10000 blocks! 10K! You've built a city!" },
    { threshold: 15000, text: "15000 blocks. The world is missing some blocks." },
    { threshold: 20000, text: "20000 blocks. Duodecakiloblock destruction! You've built a metropolis!" },
    { threshold: 25000, text: "25000 blocks. Quarter-hundred-thousand! The math is weird but you're doing great!" },
    { threshold: 30000, text: "30000 blocks. A small nation appears!" },
    { threshold: 35000, text: "35000 blocks. The world is considering a restraining order." },
    { threshold: 40000, text: "40000 blocks. Quadragintakiloblock carnage! You're a world-shaper!" },
    { threshold: 45000, text: "45000 blocks. Almost fifty thousand! The world is crying." },
    { threshold: 50000, text: "50000 blocks. Fifty thousand! You've built an empire!" },
    { threshold: 60000, text: "60000 blocks. Sexagintakiloblock destruction! The world is missing a continent." },
    { threshold: 70000, text: "70000 blocks. The world is considering therapy." },
    { threshold: 80000, text: "80000 blocks. Octogintakiloblock carnage! You're a planet sculptor!" },
    { threshold: 90000, text: "90000 blocks. Almost a hundred thousand! The galaxy is terrified." },
    { threshold: 100000, text: "100000 blocks! 100K blocks! You've built a kingdom!" },
    { threshold: 150000, text: "150K blocks. The world is missing a small country." },
    { threshold: 200000, text: "200K blocks. Duocentury kiloblock destruction! You've built a kingdom!" },
    { threshold: 250000, text: "250K blocks. Quarter-million club! The world is concerned." },
    { threshold: 300000, text: "300K blocks. A large nation appears!" },
    { threshold: 350000, text: "350K blocks. The world is considering a counter-offer." },
    { threshold: 400000, text: "400K blocks. Quadricentury kiloblock carnage! You're a continent builder!" },
    { threshold: 450000, text: "450K blocks. Almost half a million! The world is sweating." },
    { threshold: 500000, text: "500K blocks. Half a million! You're reshaping the terrain!" },
    { threshold: 600000, text: "600K blocks. Sexacentury kiloblock destruction! The world is missing a hemisphere." },
    { threshold: 700000, text: "700K blocks. The world is considering a new career." },
    { threshold: 800000, text: "800K blocks. Octocentury kiloblock carnage! You're a planetary engineer!" },
    { threshold: 900000, text: "900K blocks. Almost a million! The world is terrified." },
    { threshold: 1000000, text: "1 MILLION BLOCKS! Mountain? What mountain? There is no mountain." },
    { threshold: 1500000, text: "1.5M blocks. The world is missing some planets." },
    { threshold: 2000000, text: "2M blocks. Duomillenary kiloblock destruction! You've built a planet!" },
    { threshold: 2500000, text: "2.5M blocks. Quarter-billion-block club! Wait, that's not right. But you're close!" },
    { threshold: 3000000, text: "3M blocks. A small moon appears!" },
    { threshold: 3500000, text: "3.5M blocks. The world is considering a restraining order." },
    { threshold: 4000000, text: "4M blocks. Quadmillenary kiloblock carnage! You're a cosmic builder!" },
    { threshold: 4500000, text: "4.5M blocks. Almost five million! The cosmos is crying." },
    { threshold: 5000000, text: "5M blocks. Five million! Geologists hate this one trick!" },
    { threshold: 6000000, text: "6M blocks. Sexamillenary kiloblock destruction! The crust is destabilized!" },
    { threshold: 7000000, text: "7M blocks. The world is considering a new dimension." },
    { threshold: 8000000, text: "8M blocks. Octomillenary kiloblock carnage! You've moved more earth than some construction companies!" },
    { threshold: 9000000, text: "9M blocks. Almost ten million! The planet is screaming." },
    { threshold: 10000000, text: "10M blocks! Ten million! That's roughly 3 Empire State Buildings of material!" },
    { threshold: 15000000, text: "15M blocks. The world is missing a small moon." },
    { threshold: 20000000, text: "20M blocks. Duodecamillenary kiloblock destruction! You've built a small planet!" },
    { threshold: 25000000, text: "25M blocks. Quarter-hundred-million! The math is weird but you're a god!" },
    { threshold: 30000000, text: "30M blocks. A large moon appears!" },
    { threshold: 35000000, text: "35M blocks. The world is considering a restraining order." },
    { threshold: 40000000, text: "40M blocks. Quadragintamillenary kiloblock carnage! You're a planetary destroyer!" },
    { threshold: 45000000, text: "45M blocks. Almost fifty million! The solar system is crying." },
    { threshold: 50000000, text: "50M blocks. Fifty million! You could fill the Grand Canyon!" },
    { threshold: 60000000, text: "60M blocks. Sexagintamillenary kiloblock destruction! The planet is hollow!" },
    { threshold: 70000000, text: "70M blocks. The world is considering a new universe." },
    { threshold: 80000000, text: "80M blocks. Octogintamillenary kiloblock carnage! You've mined a small planet!" },
    { threshold: 90000000, text: "90M blocks. Almost a hundred million! The galaxy is terrified." },
    { threshold: 100000000, text: "100M blocks! One hundred million! You could fill the Grand Canyon! Twice!" },
    { threshold: 150000000, text: "150M blocks. The world is missing a large moon." },
    { threshold: 200000000, text: "200M blocks. Duocentury millenary kiloblock destruction! You've built a planet!" },
    { threshold: 250000000, text: "250M blocks. Quarter-billion club! The universe is concerned." },
    { threshold: 300000000, text: "300M blocks. A small planet appears!" },
    { threshold: 350000000, text: "350M blocks. The world is considering a restraining order." },
    { threshold: 400000000, text: "400M blocks. Quadricentury millenary kiloblock carnage! You're a star builder!" },
    { threshold: 450000000, text: "450M blocks. Almost half a billion! The cosmos is sweating." },
    { threshold: 500000000, text: "500M blocks. Half a billion! You've destabilized the crust!" },
    { threshold: 600000000, text: "600M blocks. Sexacentury millenary kiloblock destruction! The planet is gone!" },
    { threshold: 700000000, text: "700M blocks. The world is considering a new dimension." },
    { threshold: 800000000, text: "800M blocks. Octocentury millenary kiloblock carnage! You've mined a moon!" },
    { threshold: 900000000, text: "900M blocks. Almost a billion! The universe is screaming." },
    { threshold: 1000000000, text: "1 BILLION BLOCKS! You've mined a small moon. It's gone now." },
    { threshold: 1500000000, text: "1.5B blocks. The world is missing a large moon." },
    { threshold: 2000000000, text: "2B blocks. Duobillion kiloblock destruction! You've built a planet!" },
    { threshold: 2500000000, text: "2.5B blocks. Quarter-trillion! Wait, that's not right. But you're close!" },
    { threshold: 3000000000, text: "3B blocks. A large planet appears!" },
    { threshold: 3500000000, text: "3.5B blocks. The world is considering a restraining order." },
    { threshold: 4000000000, text: "4B blocks. Quad-billion kiloblock carnage! You're a cosmic destroyer!" },
    { threshold: 4500000000, text: "4.5B blocks. Almost five billion! The cosmos is crying." },
    { threshold: 5000000000, text: "5B blocks. Five billion! You've destabilized the solar system!" },
    { threshold: 6000000000, text: "6B blocks. Sexa-billion kiloblock destruction! The galaxy is missing stars!" },
    { threshold: 7000000000, text: "7B blocks. The universe is considering a new physics engine." },
    { threshold: 8000000000, text: "8B blocks. Octo-billion kiloblock carnage! You've mined a planet!" },
    { threshold: 9000000000, text: "9B blocks. Almost ten billion! The universe is terrified." },
    { threshold: 10000000000, text: "10B BLOCKS! Congrats, you've destabilized the crust. And the mantle. And the core." },
];

// Quest comparisons - from newbie to completionist god
const QUEST_TIERS = [
    { threshold: 0, text: "Zero quests? The adventure awaits! Or you're just vibing. Both are valid." },
    { threshold: 1, text: "1 quest. The journey of a thousand miles begins with one quest." },
    { threshold: 2, text: "2 quests. Twice the adventure!" },
    { threshold: 3, text: "3 quests. Third time's the charm!" },
    { threshold: 4, text: "4 quests. Tetra-tasks completed!" },
    { threshold: 5, text: "5 quests. Penta-progress!" },
    { threshold: 6, text: "6 quests. Hexa-homework done!" },
    { threshold: 7, text: "7 quests. Lucky number seven! The questbook smiles." },
    { threshold: 8, text: "8 quests. Octo-objectives achieved!" },
    { threshold: 9, text: "9 quests. Almost double digits! The questbook is excited." },
    { threshold: 10, text: "10 quests done. Just getting started! The addiction begins." },
    { threshold: 15, text: "15 quests. The questbook is getting to know you." },
    { threshold: 20, text: "20 quests. Vigintuple victory! You're a questor!" },
    { threshold: 25, text: "25 quests. Dedicated questor! The questbook is proud." },
    { threshold: 30, text: "30 quests. Triginta triumphs! You're hooked." },
    { threshold: 35, text: "35 quests. The questbook is writing a sequel about you." },
    { threshold: 40, text: "40 quests. Quadraginta conquests! You're a completionist." },
    { threshold: 45, text: "45 quests. Almost fifty! The questbook is getting thick." },
    { threshold: 50, text: "50 quests. Dedicated questor! The questbook is your biography." },
    { threshold: 60, text: "60 quests. Sexaginta successes! You're a legend." },
    { threshold: 70, text: "70 quests. The questbook is considering a movie deal." },
    { threshold: 80, text: "80 quests. Octoginta achievements! You're a myth." },
    { threshold: 90, text: "90 quests. Almost a hundred! The questbook is a novel." },
    { threshold: 100, text: "100 quests! Achievement hunter mode: ACTIVATED." },
    { threshold: 150, text: "150 quests. The questbook is a encyclopedia. You're the author." },
    { threshold: 200, text: "200 quests. Duocentury conquests! You're a god." },
    { threshold: 250, text: "250 quests. Completionist tendencies detected. The questbook is scared." },
    { threshold: 300, text: "300 quests. The questbook is a library. You're the librarian." },
    { threshold: 350, text: "350 quests. The questbook is a database. You're the admin." },
    { threshold: 400, text: "400 quests. Quadricentury victories! You're a completionist deity." },
    { threshold: 450, text: "450 quests. The questbook is a server. You're the host." },
    { threshold: 500, text: "500 quests! You've read more quest books than actual books." },
    { threshold: 600, text: "600 quests. Sexacentury successes! The questbook is a religion." },
    { threshold: 700, text: "700 quests. The questbook is a universe. You're the creator." },
    { threshold: 800, text: "800 quests. Octocentury conquests! You're a completionist legend." },
    { threshold: 900, text: "900 quests. The questbook is a multiverse. You're the architect." },
    { threshold: 1000, text: "1000 quests! Walking encyclopedia of modpacks. You're the library." },
    { threshold: 1500, text: "1500 quests. The questbook is a sentient being. You're its god." },
    { threshold: 2000, text: "2000 quests. Duomillenary victories! You're a completionist myth." },
    { threshold: 2500, text: "2500 quests. Do you even sleep? The questbook is your pillow." },
    { threshold: 3000, text: "3000 quests. The questbook is a dimension. You're the explorer." },
    { threshold: 3500, text: "3500 quests. The questbook is a universe. You're the master." },
    { threshold: 4000, text: "4000 quests. Quadromillenary conquests! You're a completionist titan." },
    { threshold: 4500, text: "4500 quests. The questbook is a multiverse. You're the overlord." },
    { threshold: 5000, text: "5000 quests! Legend status unlocked. The questbook bows." },
    { threshold: 6000, text: "6000 quests. Sexamillenary successes! You're a completionist deity." },
    { threshold: 7000, text: "7000 quests. The questbook is a cosmic entity. You're its creator." },
    { threshold: 8000, text: "8000 quests. Octomillenary victories! You're a completionist god." },
    { threshold: 9000, text: "9000 quests. The questbook is a singularity. You're the event horizon." },
    { threshold: 10000, text: "10000 quests! Modpack developers consult you. You're the oracle." },
    { threshold: 15000, text: "15000 quests. The questbook is a black hole. You're the singularity." },
    { threshold: 20000, text: "20000 quests. Duodecamillenary conquests! You're a completionist cosmic entity." },
    { threshold: 25000, text: "25000 quests. The questbook is a universe. You're the big bang." },
    { threshold: 30000, text: "30000 quests. The questbook is a multiverse. You're the architect of reality." },
    { threshold: 35000, text: "35000 quests. The questbook is a dimension. You're the god." },
    { threshold: 40000, text: "40000 quests. Quadragintamillenary victories! You're a completionist legend." },
    { threshold: 45000, text: "45000 quests. The questbook is a sentient multiverse. You're its master." },
    { threshold: 50000, text: "50000 quests! You've completed more quests than some games have content." },
    { threshold: 60000, text: "60000 quests. Sexagintamillenary successes! You're a completionist myth." },
    { threshold: 70000, text: "70000 quests. The questbook is a cosmic library. You're the librarian." },
    { threshold: 80000, text: "80000 quests. Octogintamillenary conquests! You're a completionist titan." },
    { threshold: 90000, text: "90000 quests. The questbook is a universe of knowledge. You're the scholar." },
    { threshold: 100000, text: "100000 quests! At this point, you ARE the questbook." },
];

// Jump comparisons
const JUMP_TIERS = [
    { threshold: 0, text: "Zero jumps? Are you okay? Is your spacebar broken?" },
    { threshold: 1, text: "1 jump. A single, perfect hop." },
    { threshold: 2, text: "2 jumps. Twice the hops!" },
    { threshold: 3, text: "3 jumps. Triple jump! Mario is proud." },
    { threshold: 4, text: "4 jumps. Quadra-hop! You're getting somewhere." },
    { threshold: 5, text: "5 jumps. Penta-hop! The spacebar is warm." },
    { threshold: 6, text: "6 jumps. Hexa-hop! The legs are working." },
    { threshold: 7, text: "7 jumps. Lucky number seven! The spacebar is happy." },
    { threshold: 8, text: "8 jumps. Octo-hop! You're a bunny!" },
    { threshold: 9, text: "9 jumps. Almost double digits! The anticipation!" },
    { threshold: 10, text: "10 jumps. Double digits! Light hopping." },
    { threshold: 15, text: "15 jumps. The spacebar is getting a workout." },
    { threshold: 20, text: "20 jumps. The legs are feeling it." },
    { threshold: 25, text: "25 jumps. Quarter-century of hops!" },
    { threshold: 30, text: "30 jumps. A decent workout!" },
    { threshold: 35, text: "35 jumps. The spacebar is considering a break." },
    { threshold: 40, text: "40 jumps. Quadraginta hops! You're a kangaroo!" },
    { threshold: 45, text: "45 jumps. Almost fifty! The spacebar is sweating." },
    { threshold: 50, text: "50 jumps. Half a hundred hops! Bunny mode: ACTIVATED." },
    { threshold: 60, text: "60 jumps. Sexaginta hops! The spacebar is crying." },
    { threshold: 70, text: "70 jumps. The legs are now independent contractors." },
    { threshold: 80, text: "80 jumps. Octoginta hops! Professional hopper!" },
    { threshold: 90, text: "90 jumps. Almost a hundred! The spacebar is screaming." },
    { threshold: 100, text: "100 jumps! Bunny mode: ENGAGED." },
    { threshold: 150, text: "150 jumps. The spacebar is filing for workers' comp." },
    { threshold: 200, text: "200 jumps. Duocentury hops! Your legs are meta." },
    { threshold: 250, text: "250 jumps. Quarter-thousand hops! The spacebar is broken." },
    { threshold: 300, text: "300 jumps. Triginta hops! You're a kangaroo!" },
    { threshold: 350, text: "350 hops. The spacebar is a memory." },
    { threshold: 400, text: "400 hops. Quadricentury hops! You've achieved orbit." },
    { threshold: 450, text: "450 hops. Almost five hundred! The spacebar is a legend." },
    { threshold: 500, text: "500 hops. Half a thousand hops! Your legs are cosmic." },
    { threshold: 600, text: "600 hops. Sexacentury hops! The spacebar is a myth." },
    { threshold: 700, text: "700 hops. The legs are now a separate entity." },
    { threshold: 800, text: "800 hops. Octocentury hops! Professional kangaroo status." },
    { threshold: 900, text: "900 hops. Almost a thousand! The spacebar is a deity." },
    { threshold: 1000, text: "1000 hops! 1K hops! Your keyboard is crying." },
    { threshold: 1500, text: "1500 hops. The spacebar is a memory. A legend." },
    { threshold: 2000, text: "2000 hops. Duokilohop destruction! You've achieved orbit." },
    { threshold: 2500, text: "2500 hops. Quarter-million hops! Wait, that's not right. But you're close!" },
    { threshold: 3000, text: "3000 hops. Trigintakilo hops! Your legs exist in another dimension." },
    { threshold: 3500, text: "3500 hops. The spacebar is a singularity." },
    { threshold: 4000, text: "4000 hops. Quadkilohop carnage! You've hopped to the moon." },
    { threshold: 4500, text: "4500 hops. Almost five thousand! The spacebar is a black hole." },
    { threshold: 5000, text: "5000 hops. Five thousand hops! Your legs are a cosmic entity." },
    { threshold: 6000, text: "6000 hops. Sexakilohop destruction! The spacebar is a myth." },
    { threshold: 7000, text: "7000 hops. The legs are now a separate dimension." },
    { threshold: 8000, text: "8000 hops. Octokilohop carnage! You've hopped to Mars." },
    { threshold: 9000, text: "9000 hops. Almost ten thousand! The spacebar is a legend." },
    { threshold: 10000, text: "10000 hops! 10K hops! You've achieved orbit through hopping." },
    { threshold: 15000, text: "15000 hops. The spacebar is a memory. A cosmic memory." },
    { threshold: 20000, text: "20000 hops. Duodecakilohop destruction! Your legs are a myth." },
    { threshold: 25000, text: "25000 hops. Quarter-hundred-thousand hops! The math is weird but you're a god!" },
    { threshold: 30000, text: "30000 hops. Trigintakilo hops! Your legs exist in another dimension now." },
    { threshold: 35000, text: "35000 hops. The spacebar is a singularity. You're the event horizon." },
    { threshold: 40000, text: "40000 hops. Quadragintakilohop carnage! You've hopped to the moon and back." },
    { threshold: 45000, text: "45000 hops. Almost fifty thousand! The spacebar is a deity." },
    { threshold: 50000, text: "50000 hops. Fifty thousand hops! Your legs are a cosmic entity." },
    { threshold: 60000, text: "60000 hops. Sexagintakilohop destruction! The spacebar is a myth." },
    { threshold: 70000, text: "70000 hops. The legs are now a separate universe." },
    { threshold: 80000, text: "80000 hops. Octogintakilohop carnage! You've hopped to Mars and back." },
    { threshold: 90000, text: "90000 hops. Almost a hundred thousand! The spacebar is a legend." },
    { threshold: 100000, text: "100000 hops! 100K hops! Your legs exist in another dimension now." },
    { threshold: 150000, text: "150K hops. The spacebar is a memory. A cosmic memory." },
    { threshold: 200000, text: "200K hops. Duocentury kilohop destruction! You've hopped to the moon." },
    { threshold: 250000, text: "250K hops. Quarter-million hops! The math is weird but you're a god!" },
    { threshold: 300000, text: "300K hops. Trigintakilo hops! Your legs are a myth." },
    { threshold: 350000, text: "350K hops. The spacebar is a singularity. You're the event horizon." },
    { threshold: 400000, text: "400K hops. Quadricentury kilohop carnage! You've hopped to the moon and back." },
    { threshold: 450000, text: "450K hops. Almost half a million! The spacebar is a deity." },
    { threshold: 500000, text: "500K hops. Half a million hops! Your legs are a cosmic entity." },
    { threshold: 600000, text: "600K hops. Sexacentury kilohop destruction! The spacebar is a myth." },
    { threshold: 700000, text: "700K hops. The legs are now a separate universe." },
    { threshold: 800000, text: "800K hops. Octocentury kilohop carnage! You've hopped to Mars." },
    { threshold: 900000, text: "900K hops. Almost a million! The spacebar is a legend." },
    { threshold: 1000000, text: "1 MILLION JUMPS! You've achieved orbit through hopping. Your legs are a cosmic entity." },
];

// Chunk claim comparisons
const CHUNK_TIERS = [
    { threshold: 0, text: "No claims. A true nomad. The wind is your home." },
    { threshold: 1, text: "1 chunk. A humble beginning. A single plot." },
    { threshold: 2, text: "2 chunks. Twice the territory!" },
    { threshold: 3, text: "3 chunks. A nice little triangle!" },
    { threshold: 4, text: "4 chunks. A square of safety!" },
    { threshold: 5, text: "5 chunks. A pentagon of protection!" },
    { threshold: 6, text: "6 chunks. A hexagon of home!" },
    { threshold: 7, text: "7 chunks. Lucky number seven! The land is yours." },
    { threshold: 8, text: "8 chunks. An octagon of ownership!" },
    { threshold: 9, text: "9 chunks. Almost double digits! The anticipation!" },
    { threshold: 10, text: "10 chunks. A modest plot. The beginning of an empire." },
    { threshold: 15, text: "15 chunks. The land is starting to know you." },
    { threshold: 20, text: "20 chunks. A nice territory! The map is filling in." },
    { threshold: 25, text: "25 chunks. Quarter-hundred! The empire grows." },
    { threshold: 30, text: "30 chunks. A decent kingdom!" },
    { threshold: 35, text: "35 chunks. The land is considering a tribute." },
    { threshold: 40, text: "40 chunks. Quadraginta plots! You're a baron!" },
    { threshold: 45, text: "45 chunks. Almost fifty! The empire looms!" },
    { threshold: 50, text: "50 chunks. Nice territory! The map is yours." },
    { threshold: 60, text: "60 chunks. Sexaginta plots! You're a lord!" },
    { threshold: 70, text: "70 chunks. The land is bowing." },
    { threshold: 80, text: "80 chunks. Octoginta plots! You're a king!" },
    { threshold: 90, text: "90 chunks. Almost a hundred! The empire is rising." },
    { threshold: 100, text: "100 chunks! Small kingdom vibes. The crown is yours." },
    { threshold: 150, text: "150 chunks. The land is yours. All of it." },
    { threshold: 200, text: "200 chunks. Duocentury plots! You're an emperor!" },
    { threshold: 250, text: "250 chunks. Land baron status. The map is your canvas." },
    { threshold: 300, text: "300 chunks. A large kingdom!" },
    { threshold: 350, text: "350 chunks. The land is considering a treaty." },
    { threshold: 400, text: "400 chunks. Quadricentury plots! You're a conqueror!" },
    { threshold: 450, text: "450 chunks. Almost five hundred! The empire is vast." },
    { threshold: 500, text: "500 chunks! You own a small nation. The flag is yours." },
    { threshold: 600, text: "600 chunks. Sexacentury plots! You're a sovereign!" },
    { threshold: 700, text: "700 chunks. The land is yours. The world is next." },
    { threshold: 800, text: "800 chunks. Octocentury plots! You're a titan!" },
    { threshold: 900, text: "900 chunks. Almost a thousand! The empire is cosmic." },
    { threshold: 1000, text: "1000 chunks. Manifest destiny achieved. The world is yours." },
    { threshold: 1500, text: "1500 chunks. The map is your property." },
    { threshold: 2000, text: "2000 chunks. Duokilochunk plots! You're a cosmic entity!" },
    { threshold: 2500, text: "2500 chunks. Quarter-million chunks! Wait, that's 250K. You're at 2.5K." },
    { threshold: 3000, text: "3000 chunks. A large empire!" },
    { threshold: 3500, text: "3500 chunks. The world is considering a restraining order." },
    { threshold: 4000, text: "4000 chunks. Quadkilochunk plots! You're a legend!" },
    { threshold: 4500, text: "4500 chunks. Almost five thousand! The map is your domain." },
    { threshold: 5000, text: "5000 chunks. Five thousand! Cartographers fear you." },
    { threshold: 6000, text: "6000 chunks. Sexakilochunk plots! You're a myth!" },
    { threshold: 7000, text: "7000 chunks. The world is yours. The universe is next." },
    { threshold: 8000, text: "8000 chunks. Octokilochunk plots! You're a titan!" },
    { threshold: 9000, text: "9000 chunks. Almost ten thousand! The map is your kingdom." },
    { threshold: 10000, text: "10000 chunks! You've claimed more land than some actual countries." },
];

// Server count comparisons
const SERVER_TIERS = [
    { threshold: 1, text: "Loyal to one server! True dedication!" },
    { threshold: 2, text: "2 servers. Twice the adventure!" },
    { threshold: 3, text: "3 servers. Variety seeker! The world is your oyster." },
    { threshold: 4, text: "4 servers. Tetra-explorer! You're getting around." },
    { threshold: 5, text: "5 servers! True explorer. The universe is yours." },
    { threshold: 6, text: "6 servers. Hexa-hopper! You're a nomad." },
    { threshold: 7, text: "7 servers. Lucky number seven! The servers are lucky to have you." },
    { threshold: 8, text: "8 servers. Octo-explorer! You're a legend." },
    { threshold: 9, text: "9 servers. Almost double digits! The anticipation!" },
    { threshold: 10, text: "10+ servers. You've been everywhere! The veteran." },
    { threshold: 11, text: "11 servers. The servers are forming a fan club." },
    { threshold: 12, text: "12 servers. A dozen adventures! You're a myth." },
    { threshold: 13, text: "13 servers. Lucky number thirteen! The servers are blessed." },
    { threshold: 14, text: "14 servers. The servers are considering a tribute." },
    { threshold: 15, text: "15 servers. Penta-dec-explorer! You're a cosmic entity." },
    { threshold: 16, text: "16 servers. The servers are writing epic poems about you." },
    { threshold: 17, text: "17 servers. The servers are considering a merger to host you." },
    { threshold: 18, text: "18 servers. Octodeca-explorer! You're a legend." },
    { threshold: 19, text: "19 servers. Almost twenty! The veteran status is yours." },
    { threshold: 20, text: "20+ servers! ValhallaMC veteran. The legend is real." },
    { threshold: 21, text: "21 servers. Blackjack! The servers are your casino." },
    { threshold: 22, text: "22 servers. The servers are considering a dedicated network for you." },
    { threshold: 23, text: "23 servers. The servers are writing a biography: 'The Player Who Played Everything'." },
    { threshold: 24, text: "24 servers. The servers are considering a 24/7 channel for you." },
    { threshold: 25, text: "25+ servers. A quarter of a hundred! You're a cosmic explorer." },
    { threshold: 26, text: "26 servers. The servers are forming a union. You're the president." },
    { threshold: 27, text: "27 servers. The servers are considering a constellation named after you." },
    { threshold: 28, text: "28 servers. The servers are writing epic sagas about your adventures." },
    { threshold: 29, text: "29 servers. Almost thirty! The legend grows." },
    { threshold: 30, text: "30+ servers. You basically live here. The universe is your home." },
    { threshold: 31, text: "31 servers. The servers are considering a calendar of your visits." },
    { threshold: 32, text: "32 servers. The servers are writing a 32-volume encyclopedia of you." },
    { threshold: 33, text: "33 servers. The servers are considering a religion. You're the deity." },
    { threshold: 34, text: "34 servers. The servers are forming a galaxy. You're the center." },
    { threshold: 35, text: "35+ servers. The servers are your domain." },
    { threshold: 36, text: "36 servers. The servers are considering a 36-hour day to accommodate you." },
    { threshold: 37, text: "37 servers. The servers are writing a 37-chapter book: 'The Player Who Conquered All'." },
    { threshold: 38, text: "38 servers. The servers are considering a monument. You're the monument." },
    { threshold: 39, text: "39 servers. Almost forty! The legend is cosmic." },
    { threshold: 40, text: "40+ servers. The servers are your kingdom." },
    { threshold: 41, text: "41 servers. The servers are considering a 41-gun salute. For you." },
    { threshold: 42, text: "42 servers. The answer to life, the universe, and everything. It's you." },
    { threshold: 43, text: "43 servers. The servers are writing a 43-verse poem about you." },
    { threshold: 44, text: "44 servers. The servers are considering a 44-day festival in your honor." },
    { threshold: 45, text: "45+ servers. The servers are your empire." },
    { threshold: 46, text: "46 servers. The servers are considering a 46-episode documentary: 'The Legend'." },
    { threshold: 47, text: "47 servers. The servers are writing a 47-page resume for you." },
    { threshold: 48, text: "48 servers. The servers are considering a 48-hour day. For you." },
    { threshold: 49, text: "49 servers. Almost fifty! The legend is infinite." },
    { threshold: 50, text: "50+ servers?! You've tried EVERYTHING. You're the universe." },
    { threshold: 51, text: "51 servers. The servers are considering a 51st state. It's you." },
    { threshold: 52, text: "52 servers. A deck of servers! You're the joker and the ace." },
    { threshold: 53, text: "53 servers. Prime number of primed servers! You're prime." },
    { threshold: 54, text: "54 servers. The servers are writing a 54-chapter epic. You're the hero." },
    { threshold: 55, text: "55 servers. Double fives! The servers are cheering your name." },
    { threshold: 56, text: "56 servers. The servers are considering a 56k modem. For nostalgia." },
    { threshold: 57, text: "57 servers. Heinz 57 varieties of gameplay! You're the sauce." },
    { threshold: 58, text: "58 servers. The servers are forming a 58-piece orchestra. You're the conductor." },
    { threshold: 59, text: "59 servers. Almost 60! The anticipation is server-wide." },
    { threshold: 60, text: "60+ servers. Sexaginta servers! You're a nomad legend." },
    { threshold: 61, text: "61 servers. The servers are considering a prime membership. For you." },
    { threshold: 62, text: "62 servers. The servers are writing a 62-page manual: 'How to Be You'." },
    { threshold: 63, text: "63 servers. The servers are forming a 63-grid. You're the center square." },
    { threshold: 64, text: "64 servers. 64-bit gaming! You're the processor." },
    { threshold: 65, text: "65 servers. The servers are considering retirement. You're their pension." },
    { threshold: 66, text: "66 servers. Route 66! The servers are a highway. You're the driver." },
    { threshold: 67, text: "67 servers. The servers are writing a 67-verse ballad. You're the subject." },
    { threshold: 68, text: "68 servers. The servers are forming a 68-team tournament. You're the champion." },
    { threshold: 69, text: "69 servers. Nice. The servers are giggling. You're the reason." },
    { threshold: 70, text: "70+ servers. Septuaginta servers! You're a multiversal entity." },
    { threshold: 71, text: "71 servers. The servers are forming a 71-gun salute. For you." },
    { threshold: 72, text: "72 servers. The servers are considering 72 virgins. Wait, wrong religion." },
    { threshold: 73, text: "73 servers. The servers are writing a 73-question quiz. You're the answer." },
    { threshold: 74, text: "74 servers. The servers are forming a 74-band. You're the rockstar." },
    { threshold: 75, text: "75 servers. Three quarters of a hundred! The servers are your empire." },
    { threshold: 76, text: "76 servers. The servers are writing a 76-trombone parade. You're the leader." },
    { threshold: 77, text: "77 servers. Lucky sevens! The servers are your casino. You always win." },
    { threshold: 78, text: "78 servers. The servers are forming a 78-record collection. You're the vinyl." },
    { threshold: 79, text: "79 servers. Almost 80! The servers are getting excited." },
    { threshold: 80, text: "80 servers. Octoginta servers! You're a universal constant." },
    { threshold: 81, text: "81+ servers. You are the life of Valhalla. The network breathes because you play." },
];

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Gets a scaled comparison message based on value.
 * Uses logarithmic scaling for extreme values (0 → 25 → 50 → 100 → 250 → 500 → 1K → 10K → 100K → 1M → 1B)
 * @param {number} value - The stat value
 * @param {Array} tiers - Array of {threshold, text} objects sorted ascending
 * @returns {string} The matching comparison text
 */
function getScaledMessage(value, tiers) {
    // Find the highest threshold that value exceeds
    let result = tiers[0]?.text || '';
    for (const tier of tiers) {
        if (value >= tier.threshold) {
            result = tier.text;
        }
    }
    return result;
}

/**
 * Formats a large number with appropriate suffix (K, M, B, T).
 * Handles negative numbers (from overflow) by taking absolute value.
 * @param {number} num - Number to format
 * @returns {string} Formatted number
 */
function formatNumber(num) {
    if (num === undefined || num === null || isNaN(num)) return '0';
    // Handle potential integer overflow (negative numbers from overflow)
    num = Math.abs(Math.floor(num));
    
    if (num >= 1e12) return `${(num / 1e12).toFixed(1)}T`;
    if (num >= 1e9) return `${(num / 1e9).toFixed(1)}B`;
    if (num >= 1e6) return `${(num / 1e6).toFixed(1)}M`;
    if (num >= 1e3) return `${(num / 1e3).toFixed(1)}K`;
    return num.toLocaleString('en-US');
}

/**
 * Formats a number with full comma separation.
 * @param {number} num - Number to format
 * @returns {string} Formatted number with commas
 */
function formatNumberFull(num) {
    if (num === undefined || num === null || isNaN(num)) return '0';
    return Math.abs(Math.floor(num)).toLocaleString('en-US');
}

/**
 * Converts ticks to human-readable time.
 * @param {number} ticks - Game ticks (20 ticks = 1 second)
 * @returns {string} Human readable time
 */
function ticksToReadableTime(ticks) {
    if (!ticks || isNaN(ticks)) return '0h';
    const totalSeconds = Math.floor(ticks / 20);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    
    if (hours >= 24) {
        const days = Math.floor(hours / 24);
        const remainingHours = hours % 24;
        return `${days}d ${remainingHours}h`;
    }
    
    return `${hours}h ${minutes}m`;
}

/**
 * Converts centimeters to kilometers.
 * @param {number} cm - Distance in centimeters
 * @returns {number} Distance in kilometers
 */
function cmToKm(cm) {
    return (cm || 0) / 100000;
}

/**
 * Formats a Minecraft item/block ID for display.
 * @param {string} id - Minecraft ID like "minecraft:stone"
 * @returns {string} Formatted name like "Stone"
 */
function formatMinecraftId(id) {
    if (!id) return 'Unknown';
    // Handle numeric IDs from older Minecraft versions
    if (/^\d+$/.test(id)) return `Block #${id}`;
    const name = id.includes(':') ? id.split(':')[1] : id;
    return name.split('_').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

// ============================================================================
// MAIN EMBED GENERATOR - Single consolidated embed
// ============================================================================

/**
 * Generates a single comprehensive Wrapped embed.
 * @param {object} stats - Aggregated player stats from wrappedStatsAggregator
 * @param {string} username - Player's Minecraft username
 * @returns {Array<EmbedBuilder>} Array containing 1-2 embeds
 */
function generateWrappedEmbeds(stats, username) {
    // Handle no data case
    if (!stats || stats.totals.servers_played === 0) {
        const noDataEmbed = new EmbedBuilder()
            .setColor(0x9B59B6)
            .setTitle(`${username}'s ValhallaMC Wrapped`)
            .setDescription(
                `We couldn't find any statistics for **${username}** in our archives.\n\n` +
                `This could mean:\n` +
                `• You haven't played on ValhallaMC\n` +
                `• Your data wasn't captured in our snapshot\n` +
                `• The username/UUID doesn't match our records\n\n` +
                `*Data collected until December 22, 2025*`
            )
            .setThumbnail(`https://mc-heads.net/avatar/${username}/128`)
            .setTimestamp()
            .setFooter({ text: 'ValhallaMC Wrapped' });
        return [noDataEmbed];
    }
    
    // Calculate derived stats
    const playtimeHours = stats.totals.play_time_ticks / 20 / 3600;
    const totalDistanceKm = cmToKm(
        stats.totals.walk_distance + 
        stats.totals.sprint_distance + 
        stats.totals.fly_distance + 
        stats.totals.swim_distance
    );
    const walkKm = cmToKm(stats.totals.walk_distance);
    const sprintKm = cmToKm(stats.totals.sprint_distance);
    const flyKm = cmToKm(stats.totals.fly_distance);
    const swimKm = cmToKm(stats.totals.swim_distance);
    const incompleteQuests = Math.max(0, stats.totals.quests_started - stats.totals.quests_completed);
    
    // Build the main embed
    const mainEmbed = new EmbedBuilder()
        .setColor(0x9B59B6)
        .setTitle(`${username}'s ValhallaMC Wrapped`)
        .setThumbnail(`https://mc-heads.net/avatar/${username}/128`)
        .setTimestamp()
        .setFooter({ text: 'ValhallaMC Wrapped • Data until Dec 22, 2025' });
    
    // Build description with all stats in a clean format
    let description = `*Your journey across ${stats.totals.servers_played} server${stats.totals.servers_played > 1 ? 's' : ''}, preserved forever.*\n`;
    description += `${getScaledMessage(stats.totals.servers_played, SERVER_TIERS)}\n\n`;
    
    // PLAYTIME SECTION
    description += `**PLAYTIME**\n`;
    description += `Total: **${ticksToReadableTime(stats.totals.play_time_ticks)}** (${formatNumber(playtimeHours)} hours)\n`;
    if (stats.top_stats.favorite_server.name) {
        description += `Favorite: **${stats.top_stats.favorite_server.name}** (${ticksToReadableTime(stats.top_stats.favorite_server.playtime)})\n`;
    }
    description += `*${getScaledMessage(Math.floor(playtimeHours), PLAYTIME_TIERS)}*\n\n`;
    
    // COMBAT SECTION
    description += `**COMBAT & SURVIVAL**\n`;
    description += `Deaths: **${formatNumber(stats.totals.deaths)}** | Mob Kills: **${formatNumber(stats.totals.mob_kills)}** | PvP Kills: **${formatNumber(stats.totals.player_kills)}**\n`;
    const totalKills = stats.totals.mob_kills + stats.totals.player_kills;
    const kdRatio = stats.totals.deaths > 0
        ? (totalKills / stats.totals.deaths).toFixed(2)
        : '∞';
    description += `K/D Ratio: **${kdRatio}** | `;
    description += `Damage: **${formatNumber(stats.totals.damage_dealt / 2)}** hearts dealt, **${formatNumber(stats.totals.damage_taken / 2)}** taken\n`;
    if (stats.top_stats.most_killed_mob.name) {
        description += `Most hunted: **${formatMinecraftId(stats.top_stats.most_killed_mob.name)}** (${formatNumber(stats.top_stats.most_killed_mob.count)})\n`;
    }
    if (stats.top_stats.top_killer.name) {
        description += `Nemesis: **${formatMinecraftId(stats.top_stats.top_killer.name)}** (killed you ${formatNumber(stats.top_stats.top_killer.count)}x)\n`;
    }
    description += `*${getScaledMessage(totalKills, KILL_TIERS)}*\n`;
    description += `*${getScaledMessage(stats.totals.deaths, DEATH_TIERS)}*\n\n`;
    
    // EXPLORATION SECTION
    description += `**EXPLORATION**\n`;
    description += `Total distance: **${formatNumber(totalDistanceKm)} km**\n`;
    description += `Walk: ${formatNumber(walkKm)}km | Sprint: ${formatNumber(sprintKm)}km | Fly: ${formatNumber(flyKm)}km | Swim: ${formatNumber(swimKm)}km\n`;
    description += `Jumps: **${formatNumber(stats.totals.jumps)}**\n`;
    description += `*${getScaledMessage(stats.totals.jumps, JUMP_TIERS)}*\n`;
    description += `*${getScaledMessage(totalDistanceKm, DISTANCE_TIERS)}*\n\n`;
    
    // BUILDING SECTION
    description += `**BUILDING & CRAFTING**\n`;
    description += `Blocks mined: **${formatNumber(stats.totals.blocks_mined)}** | Items crafted: **${formatNumber(stats.totals.items_crafted)}**\n`;
    if (stats.top_stats.most_mined_block.name) {
        description += `Most mined: **${formatMinecraftId(stats.top_stats.most_mined_block.name)}** (${formatNumber(stats.top_stats.most_mined_block.count)})\n`;
    }
    if (stats.top_stats.most_crafted_item.name) {
        description += `Most crafted: **${formatMinecraftId(stats.top_stats.most_crafted_item.name)}** (${formatNumber(stats.top_stats.most_crafted_item.count)})\n`;
    }
    description += `*${getScaledMessage(stats.totals.blocks_mined, BLOCK_TIERS)}*\n\n`;
    
    // QUESTS & TERRITORY SECTION
    if (stats.totals.quests_completed > 0 || stats.totals.quests_started > 0 || stats.totals.chunks_claimed > 0) {
        description += `**QUESTS & TERRITORY**\n`;
        if (stats.totals.quests_completed > 0 || stats.totals.quests_started > 0) {
            description += `Quests: **${formatNumber(stats.totals.quests_completed)}** completed`;
            if (incompleteQuests > 0) {
                description += ` | **${formatNumber(incompleteQuests)}** incomplete`;
            }
            description += `\n`;
            description += `*${getScaledMessage(stats.totals.quests_completed, QUEST_TIERS)}*\n`;
        }
        if (stats.totals.chunks_claimed > 0) {
            description += `Chunks claimed: **${formatNumber(stats.totals.chunks_claimed)}**`;
            if (stats.totals.chunks_force_loaded > 0) {
                description += ` (${formatNumber(stats.totals.chunks_force_loaded)} force-loaded)`;
            }
            description += `\n`;
            description += `*${getScaledMessage(stats.totals.chunks_claimed, CHUNK_TIERS)}*\n`;
        }
        if (stats.totals.homes_set > 0) {
            description += `Homes set: **${formatNumber(stats.totals.homes_set)}**\n`;
            description += `*${getScaledMessage(stats.totals.homes_set, HOMES_TIERS)}*\n`;
        }
        description += `\n`;
    }
    
    // ECONOMY SECTION (villager trades, enchants, chests)
    const hasEconomyStats = stats.totals.villager_trades > 0 || stats.totals.items_enchanted > 0 || stats.totals.chests_opened > 0;
    if (hasEconomyStats) {
        description += `**ECONOMY**\n`;
        const economyParts = [];
        if (stats.totals.villager_trades > 0) {
            economyParts.push(`Villager trades: **${formatNumber(stats.totals.villager_trades)}**`);
        }
        if (stats.totals.items_enchanted > 0) {
            economyParts.push(`Items enchanted: **${formatNumber(stats.totals.items_enchanted)}**`);
        }
        if (stats.totals.chests_opened > 0) {
            economyParts.push(`Chests opened: **${formatNumber(stats.totals.chests_opened)}**`);
        }
        description += economyParts.join(' | ') + '\n\n';
    }
    
    // FARMING SECTION (animals bred, fish caught, misc)
    const hasFarmingStats = stats.totals.animals_bred > 0 || stats.totals.fish_caught > 0 || stats.totals.cake_slices > 0 || stats.totals.times_slept > 0;
    if (hasFarmingStats) {
        description += `**LIFE ON THE FARM**\n`;
        const farmParts = [];
        if (stats.totals.animals_bred > 0) {
            farmParts.push(`Animals bred: **${formatNumber(stats.totals.animals_bred)}**`);
        }
        if (stats.totals.fish_caught > 0) {
            farmParts.push(`Fish caught: **${formatNumber(stats.totals.fish_caught)}**`);
        }
        if (stats.totals.times_slept > 0) {
            farmParts.push(`Nights slept: **${formatNumber(stats.totals.times_slept)}**`);
        }
        if (stats.totals.cake_slices > 0) {
            farmParts.push(`Cake slices eaten: **${formatNumber(stats.totals.cake_slices)}**`);
        }
        description += farmParts.join(' | ') + '\n';
        if (stats.totals.raiders_killed > 0) {
            description += `Raiders defeated: **${formatNumber(stats.totals.raiders_killed)}**\n`;
        }
        if (stats.totals.bells_rung > 0) {
            description += `Bells rung: **${formatNumber(stats.totals.bells_rung)}**\n`;
        }
        description += '\n';
    }
    
    // FIRST SEEN SECTION (when they started playing)
    if (stats.first_seen && stats.first_seen.date) {
        const firstDate = stats.first_seen.date;
        const now = new Date();
        const daysSinceFirst = Math.floor((now - firstDate) / (1000 * 60 * 60 * 24));
        const monthsSinceFirst = Math.floor(daysSinceFirst / 30);
        const yearsSinceFirst = Math.floor(daysSinceFirst / 365);
        
        let durationStr;
        if (yearsSinceFirst >= 1) {
            durationStr = `${yearsSinceFirst} year${yearsSinceFirst > 1 ? 's' : ''}`;
        } else if (monthsSinceFirst >= 1) {
            durationStr = `${monthsSinceFirst} month${monthsSinceFirst > 1 ? 's' : ''}`;
        } else {
            durationStr = `${daysSinceFirst} day${daysSinceFirst > 1 ? 's' : ''}`;
        }
        
        const dateStr = firstDate.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
        description += `**FIRST SEEN**\n`;
        description += `Playing since **${dateStr}** (${durationStr} ago)\n`;
        description += `First server: **${stats.first_seen.server}**\n`;
    }
    // DATA DISCLAIMER SECTION
    description += `\n**DATA NOTES**\n`;
    description += `*This summary represents a sample from our archives and may contain minor inaccuracies. While we've made every effort to narrow down and verify the data, some statistics may be approximate due to collection limitations.*\n`;
    
    // Check if description is too long and needs a second embed
    const MAX_DESCRIPTION_LENGTH = 3800; // Leave some buffer under 4096 limit
    
    let mainDescription = description;
    let overflowContent = null;
    
    if (description.length > MAX_DESCRIPTION_LENGTH) {
        // Find a good split point (at a section break)
        const sections = description.split('\n\n');
        mainDescription = '';
        overflowContent = '';
        let inOverflow = false;
        
        for (const section of sections) {
            if (!inOverflow && (mainDescription + section + '\n\n').length <= MAX_DESCRIPTION_LENGTH) {
                mainDescription += section + '\n\n';
            } else {
                inOverflow = true;
                overflowContent += section + '\n\n';
            }
        }
    }
    
    mainEmbed.setDescription(mainDescription.trim());
    const embeds = [mainEmbed];
    
    // Add overflow embed if needed
    if (overflowContent && overflowContent.trim().length > 0) {
        const overflowEmbed = new EmbedBuilder()
            .setColor(0x9B59B6)
            .setDescription(overflowContent.trim());
        embeds.push(overflowEmbed);
    }
    
    return embeds;
}

module.exports = {
    generateWrappedEmbeds,
    formatNumber,
    formatNumberFull,
    ticksToReadableTime,
    formatMinecraftId,
    getScaledMessage,
    // Export tiers for potential testing
    DISTANCE_TIERS,
    DEATH_TIERS,
    KILL_TIERS,
    BLOCK_TIERS,
    QUEST_TIERS,
    PLAYTIME_TIERS,
    JUMP_TIERS,
    CHUNK_TIERS,
    SERVER_TIERS,
    HOMES_TIERS
};