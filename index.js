let express = require( 'express' );
let twitter = require( 'twitter' );
let st = require( 'st' );
let fs = require( 'fs' );
let app = express();
let helmet = require( 'helmet' );
let bodyParser = require( 'body-parser' );
let compression = require( 'compression' );
let morgan = require( 'morgan' );
let port = process.env.PORT || 80;
let io = null;

if ( process.env.sslEnabled === "true" ) {
	const options = {
		cert: fs.readFileSync( __dirname + '/sslcert/fullchain.pem' ),
		key: fs.readFileSync( __dirname + '/sslcert/privkey.pem' )
	};
	let sslServer = require( 'https' ).createServer( options, app );
	sslServer.listen( 443 );
	io = require( 'socket.io' ).listen( sslServer );
} else {
	let server = require( 'http' ).createServer( app );
	server.listen( port );
	io = require( 'socket.io' ).listen( server );
}

let client = new twitter( {
	consumer_key: process.env.consumer_key,
	consumer_secret: process.env.consumer_secret,
	access_token_key: process.env.access_token_key,
	access_token_secret: process.env.access_token_secret
} );

function TimedLogger( data ) {
	console.log( new Date().toString() + " - " + data );
}

let raidConfigs = require( './raids.json' );

app.set( 'json spaces', 0 );
app.use( helmet() );
app.use( morgan( 'combined' ) );
app.use( compression() );
app.use( bodyParser.json() );
app.use( bodyParser.urlencoded( {
	extended: true
} ) );

app.get( '/health-check', ( req, res ) => res.sendStatus( 200 ) );

app.get( '/getraids', function ( req, res ) {
	res.header( 'Cache-Control', 'public, max-age=432000000' );
	res.send( raidConfigs );
} );

app.use( st( {
	path: __dirname + '/static',
	url: '/',
	index: '/index.html',
	gzip: true,
	dot: true,
	cache: {
		content: {
			max: 1024 * 1024 * 64, // how much memory to use on caching contents (bytes * kilo * mega)
			maxAge: 1000 * 60 * 60 * 24 * 7, // how long to cache contents for (milliseconds * seconds * minutes * hours * days)
		}
	},
	passthrough: false
} ) );

let keywords = "";

for ( let i = 0; i < raidConfigs.length; i++ ) {
	keywords += raidConfigs[ i ].english + "," + raidConfigs[ i ].japanese;
	if ( i != raidConfigs.length - 1 ) {
		keywords += ',';
	}
}

function searchTextForRaids( text ) {
	let result = "";
	for ( let i = 0; i < raidConfigs.length; i++ ) {
		if ( text.indexOf( raidConfigs[ i ].english ) != -1 || text.indexOf( raidConfigs[ i ].japanese ) != -1 ) {
			result = raidConfigs[ i ].room;
			break;
		}
	}
	return result;
}

function DoesTweetContainMessage( data ) {
	let result = false;
	if ( data.text.indexOf("参加者募集") != -1 || data.text.indexOf("I need backup") != -1 ) {
		result = true;
	}
	return result;
}

function GetTweetLanguage( data ) {
	if ( data.text.indexOf( '参戦ID' ) !== -1 ) {
		return "JP";
	} else if ( data.text.indexOf( 'Battle ID' ) !== -1 ) {
		return "EN";
	} else {
		return null;
	}
}

function GetTweetMessage( data ) {
	let result = {
		language: "JP",
		message: "No Twitter Message."
	};
	let splitString = data.text.split('\n');
	let tempMessage = splitString[1];
	if (tempMessage != "I need backup!" && tempMessage != "参加者募集！")
	{
		result.message = tempMessage;
	}
	if ( GetTweetLanguage( data ) === "JP" ) {
		result.language = "JP";
	} else if ( GetTweetLanguage( data ) === "EN" ) {
		result.language = "EN";
	}
	return result;
}

function GetRaidID( data ) {
	var result = null;
	try {
		result = data.text.substr( 0, 8 );
	} catch ( error ) {
		TimedLogger( "Twitter", "Error", error );
	}
	return result;
}

function IsValidTweet( data ) {
	let result = false;
	if ( data.source !== '<a href="http://granbluefantasy.jp/" rel="nofollow">グランブルー ファンタジー</a>' ) {
		TimedLogger( "Twitter", "Invalid Tweet Source", data.source );
	} else {
		if ( searchTextForRaids( data.text ) === null ) {
			TimedLogger( "Twitter", "No Raid Name", data.text );
		} else {
			if ( DoesTweetContainMessage( data ) && searchTextForRaids( GetTweetMessage( data ).message ) !== null ) {
				TimedLogger( "Twitter", "Message Contains Name", data.text );
			} else {
				if ( GetRaidID( data ) === null ) {
					TimedLogger( "Twitter", "No Raid ID", data.text );
				} else {
					TimedLogger( "Twitter", "Valid Tweet", "" );
					result = true;
				}
			}
		}
	}
	return result;
}

function StartTwitterStream() {
	client.stream( 'statuses/filter', {
		track: keywords
	}, function ( stream ) {
		TimedLogger( "Twitter Stream started." );
		stream.on( 'data', function ( event ) {

			TimedLogger( "Tweet found." );
			let room = searchTextForRaids( event.text );
			var message = "No Twitter Message.";
			var language = "JP";
			var raidID = GetRaidID(event)
// 			var raidID = event.text.substr( event.text.indexOf( 'ID' ) + 3, 9 );
// 			if ( raidID.charAt( 0 ) == " " ) {
// 				raidID = raidID.substr( 1, 8 );
// 			} else {
// 				raidID = raidID.substr( 0, 8 );
// 			}
			if ( event.text.substr( 0, 10 ) !== "参加者募集！参戦ID" && event.text.substr( 0, 10 ) !== "I need bac" ) {
				if ( event.text.indexOf( '参戦ID' ) !== -1 ) {
					message = event.text.substring( 0, event.text.indexOf( '参戦ID' ) - 9 );
					language = "JP";
					raidID = event.text.substr( event.text.indexOf( ':参戦ID' ) -9, 8 );
				} else if ( event.text.indexOf( 'Battle ID' ) !== -1 ) {
					message = event.text.substring( 0, event.text.indexOf( 'Battle ID' ) - 9 );
					language = "EN";
					raidID = event.text.substr( event.text.indexOf( ':Battle ID' ) -9, 8 );
				}
			}
			var raidInfo = {
				id: raidID,
				user: "@" + event.user.screen_name,
				time: event.created_at,
				room: room,
				message: message,
				language: language,
				status: "unclicked"
			};
			TimedLogger( "Raid Info: " );
			console.dir( raidInfo );
			io.to( room ).emit( 'tweet', raidInfo );
		} );

		stream.on( 'error', function ( error ) {
			TimedLogger( "Twitter Stream error:" );
			console.dir( error );
			StartTwitterStream();
		} );
		stream.on( 'disconnect', function ( disconnect ) {
			TimedLogger( "Twitter Stream disconnect:" );
			console.dir( disconnect );
			StartTwitterStream();
		} );
		stream.on( 'warning', function ( warning ) {
			TimedLogger( "Twitter Stream warning:" );
			console.dir( warning );
		} );
	} );
}

io.sockets.on( 'connection', function ( socket ) {
	TimedLogger( "New connection established." );
	socket.on( 'subscribe',
		function ( data ) {
			TimedLogger( "Room subscribed: " + data.room );
			socket.join( data.room );
		} );

	socket.on( 'unsubscribe',
		function ( data ) {
			TimedLogger( "Room unsubscribed: " + data.room );
			socket.leave( data.room );
		} );
} );

TimedLogger( "Starting GBF Raiders on port " + port + "." );

StartTwitterStream();
