//handles server stuff, ties everything together

//load external modules
var express = require("express");
var app     = express();
var server  = require("http").createServer(app);

//helper modules
var log              = require(__dirname + "/logging.js"); //load logging function
var Misc_math        = require(__dirname + "/misc_math.js");
var Colours          = require(__dirname + "/colours.js");
var Players          = require(__dirname + "/players.js");
var Universe         = require(__dirname + "/universe.js");
var Weapons          = require(__dirname + "/weapons.js");
var Celestial_bodies = require(__dirname + "/celestial_bodies.js");
var Game_events      = require(__dirname + "/events.js");
// var Shop             = require(__dirname + "/shop.js");

//planets and sun
var Sun   = new Celestial_bodies.Star("sun", 5000, 5000);
var Alpha = new Celestial_bodies.Planet(Sun, 600, "alpha", 32, "random", {r: 30, g: 144, b: 255});
var Beta  = new Celestial_bodies.Planet(Sun, 1000, "beta", 32, "random", {r: 220, g: 20, b: 60});

function get_minimap_objects() {
    return [
        {x: Alpha.x / Universe.width, y: Alpha.y / Universe.height, colour: Alpha.colour},
        {x: Beta.x / Universe.width, y: Beta.y / Universe.height, colour: Beta.colour},
        {x: Sun.x / Universe.width, y: Sun.y / Universe.height, colour: Sun.colour},
    ];
}

Universe.objects.push(Sun);
Universe.objects.push(Alpha);
Universe.objects.push(Beta);

//player needs special setup
var Player = require(__dirname + "/player.js")(Beta);

//set up express resources, assuming running from directory above
app.use(express.static("./webpage"));

app.get('/', function(req, res) {
    log("incoming connection from: " +
        (req.ip || req.headers['x-forwarded-for'] ||
        req.connection.remoteAddress), "notification"
    );

    res.sendFile("./webpage/index.html");
});

app.post('/', function(req, res) {
    var body = "";

    req.on('data', function(data) {
        body += data;

        //trop de data, tuer la connection!
        if (body.length > 1e4) {
            req.connection.destroy();
        }
    });

    req.on('end', function() {
        var colour = Colours.random();
        var name   = body.trim();
        var id     = Misc_math.random_hex_string(6);

        log("POST request from: " + (req.ip || req.headers['x-forwarded-for'] ||
            req.connection.remoteAddress) + ", with name: " + name,
            "notification"
        );

        //response?
        res.status(200);
        res.send({ colour: colour, name: name, id: id });
        res.end();
    });
});

//the socket part
var io = require("socket.io").listen(server);

io.on("connection", function(socket) {
    var player      = null;
    var id          = null;
    var last_update = null;
    var planet      = null;

    var kill_event_listener;
    var leaderboard_listener;

    // incoming ASK from client
    // some minor action to be performed
    socket.on("ask", function(data) {
		switch(data.action)
		{
			case "buy_upgrade":
				if(player.buy_upgrade(data.request.upgrade_name))
				{
					socket.emit("upgrades_update",{upgrade_bought:data.request.upgrade_name
						,next_upgrade_cost:player.get_upgrade_cost()})
				}
				else
				{
					socket.emit("notification", "unable to purchase " + data.request.upgrade_name);
				}
				break;
			case "buy_weapon":
				if(player.buy_weapon(data.request))
				{
					socket.emit("weapons_update",data.request);
					socket.emit("notification","you have purchased the " + data.request);
				}
				else
				{
					socket.emit("notification", "unable to purchase weapon " + data.request);
				}
				break;
			case "initialize":
				socket.emit("initialize",{upgrades: Object.getPrototypeOf(player).upgrades
				,weapons:Weapons});
				break;
			default:
		}

    });

    //incoming update from the client
    socket.on("client_update", function(data) {
        if (last_update != null && last_update > data.time) {
            return; //update is older than our last update, so this one is useless
        }

        if (player == null) {
            id     = data.id;
            player = new Player(data.name, data.colour, id);
            Players.add(player, id);
            log("new player => name: " + player.name +
                ", id: " + id +
                ", colour: " + JSON.stringify(data.colour),
                "notification"
            );

            Universe.objects.push(player);

            //remember to spawn the player
            player.spawn();

            kill_event_listener     = create_kill_listener(player, socket);
            leaderboard_listener    = create_leaderboard_listener(socket);

            Game_events.on("kill", kill_event_listener);
            Game_events.on("leaderboard_update", leaderboard_listener);

            Game_events.emit("score changed");
        }

        player.keys = data.keys;

        //time, for updating purposes.
        var time = Date.now();


        // camera focus x and y
        var p_x = player.x - (data.viewport.width / 2);
        var p_y = player.y - (data.viewport.height / 2);

        //viewport
        var p_w = data.viewport.width;
        var p_h = data.viewport.height;

        //infos to the player
        socket.emit("server_update", {
            player: player,
            objects: Universe.get_in_view(p_x, p_y, p_w, p_h),
            players: Players.get_in_view(p_x, p_y, p_w, p_h),
            time: time,
            offset: { x: p_x, y: p_y, },
            health: player.health,
            ammo: player.ammo,
            minimap_objects: get_minimap_objects(),
        });
    });

    socket.on("toggle orbit", function() {
        if (player.orbiting_planet) {
            player.spawn();
            player.orbiting_planet = null;
			socket.emit("orbit_update","exit");
            return;
        }

        var flag = player.enter_planet();

        if (flag == "success") {
            //entering orbit success.
            socket.emit("notification", "now orbiting planet " + player.orbiting_planet.name + ". press C or M to exit orbit.");
			// using socket because Game_events doesn't work.
			socket.emit("orbit_update","enter");
        } else if (flag == "too far") {
            //too far
            socket.emit("notification", "get closer to a planet and try again.");
        } else if (flag == "too soon") {
            //too soon
            socket.emit("notification", "you just left orbit!");
        }
    });

    socket.on("disconnect", function() {
        if (player != null) {
            //io.emit("notification", player.name + " has disconnected.");
            log(player.name + ", " + id + " has disconnected.", "info");
            Players.remove(id);
            player.active = false;

            Game_events.emit("score changed");

            Game_events.removeListener("kill", kill_event_listener);
            Game_events.removeListener("leaderboard_update", leaderboard_listener);
        }
    });

    socket.on("reconnect", function() {
        //re-add the player and the event listeners. ugh network shit
        //i actually don't know if this works.

        log(player.name + " (" + id + ") has reconnected.");

        Players.add(player, id);
        player.active = true;
        Universe.objects.push(player);

        kill_event_listener  = create_kill_listener(player, socket);
        leaderboard_listener = create_leaderboard_listener(socket);

        Game_events.on("kill", kill_event_listener);
        Game_events.on("leaderboard_update", leaderboard_listener);

        Game_events.emit("score changed");
    });
});

function create_kill_listener(player, socket) {
    return function(data) {
        if (data.killer == player.id) {
            //player got a kill! congrats!
            socket.emit("notification", "you have killed " + Players[data.victim].name);
            player.update_score("kill");
            socket.emit("kill");
        }

        if (data.victim == player.id) {
            //player got killed!
            socket.emit("notification", "you were killed by " + Players[data.killer].name);
            socket.emit("death");
        }
    };
}

function create_leaderboard_listener(socket) {
    return function() {
        socket.emit("leaderboard_update", Leaderboard);
    };
}

var Leaderboard = [];
var num_scores  = 10;

Game_events.on("score changed", function() {
    Leaderboard = Players.get_highest(num_scores);
    Game_events.emit("leaderboard_update");
});

setInterval(Celestial_bodies.spawn_asteroid(Sun, 800, 900, 50), 1000);

setImmediate(Universe.update);

var default_port = process.env.PORT || 3000;
module.exports   = function(port) {
    if (isNaN(port)) {
        port = default_port;
    }

    server.listen(port, function() {
        log("---- NEW SERVER SESSION ----", "notification");
        log("http server listening on port " + port + ".", "notification");
    });
};
