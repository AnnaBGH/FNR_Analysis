var _ = require('underscore'),
	argv = require('optimist') 
		.usage('Usage: $0 [--port portNumber]')
		// .demand([ 'port' ])
		.alias('port', 'p')
		.argv,
	async = require('async'),
	mongo = require('mongoskin').db('mongodb://localhost', { database: 'fnranalysis', safe: true, strict: false }),
	restify = require('restify'),
	zlib = require('zlib'),

	BOROUGHS_NAMES = [ "Barking and Dagenham", "Barnet", "Bexley", "Brent",
		"Bromley", "Camden", "City of London", "Croydon", "Ealing", "Enfield",
		"Greenwich", "Hackney", "Hammersmith and Fulham", "Haringey", "Harrow",
		"Havering", "Hillingdon", "Hounslow", "Islington",
		"Kensington and Chelsea", "Kingston upon Thames", "Lambeth", "Lewisham",
		"Merton", "Newham", "Redbridge", "Richmond upon Thames", "Southwark",
		"Sutton", "Tower Hamlets", "Waltham Forest", "Wandsworth",
		"Westminster" ],

	STATIONS_NAMES = [ 'Acton', 'Addington', 'Barking', 'Barnet', 'Battersea', 
		'Beckenham', 'Belsize', 'Bethnal Green', 'Bexley', 'Biggin Hill',
		'Bow', 'Brixton', 'Bromley', 'Chelsea', 'Chingford', 'Chiswick',
  		'Clapham', 'Clerkenwell', 'Croydon', 'Dagenham', 'Deptford',
  		'Dockhead', 'Dowgate', 'Downham', 'Ealing', 'East Greenwich',
  		'East Ham', 'Edmonton', 'Eltham', 'Enfield', 'Erith', 'Euston',
  		'Feltham', 'Finchley', 'Forest Hill', 'Fulham', 'Greenwich',
  		'Hainault', 'Hammersmith', 'Harold Hill', 'Harrow', 'Hayes', 'Heathrow',
  		'Hendon', 'Heston', 'Hillingdon', 'Holloway', 'Homerton', 'Hornchurch',
  		'Hornsey', 'Ilford', 'Islington', 'Kensington', 'Kentish Town',
  		'Kingsland', 'Kingston', 'Knightsbridge', 'Lambeth', 'Lee Green',
  		'Lewisham', 'Leyton', 'Leytonstone', 'Mill Hill', 'Millwall',
  		'Mitcham', 'New Cross', 'New Malden', 'Norbury', 'North Kensington',
  		'Northolt', 'Old Kent Road', 'Orpington', 'Paddington', 'Park Royal',
  		'Peckham', 'Plaistow', 'Plumstead', 'Poplar', 'Purley', 'Richmond',
  		'Romford', 'Ruislip', 'Shadwell', 'Shoreditch', 'Sidcup', 'Silvertown',
  		'Soho', 'Southall', 'Southgate', 'Southwark', 'Stanmore',
  		'Stoke Newington', 'Stratford', 'Surbiton', 'Sutton', 'Tooting',
  		'Tottenham', 'Twickenham', 'Wallington', 'Walthamstow', 'Wandsworth',
  		'Wembley', 'Wennington', 'West Hampstead', 'West Norwood', 
  		'Westminster', 'Whitechapel', 'Willesden', 'Wimbledon', 'Woodford',
 		'Woodside', 'Woolwich' ],

	// At the moment of writing, and according to the colour levels we are
	// currently using for the legend, of the statons facing closure Southwark is the
	// only single station closure that produces a visible effect on the map
	STATIONS_FACING_CLOSURE_NAMES = [ "Belsize", "Bow", "Clerkenwell",
		"Downham", "Kingsland", "Knightsbridge", "Silvertown", "Southwark",
		"Westminster", "Woolwich" ],

    SIMPLIFIED_SQUARE_LATITUDE_SIZE = 0.001,
    SIMPLIFIED_SQUARE_LONGITUDE_SIZE = 0.0015,
    LENGTH_OF_A_DEGREE_OF_LATITUDE = 111.25826132219737, // km
	LENGTH_OF_A_DEGREE_OF_LONGITUDE = 69.4032968251825, //km
	AREA_OF_ONE_SIMPLIFIED_SQUARE = SIMPLIFIED_SQUARE_LATITUDE_SIZE * 
		LENGTH_OF_A_DEGREE_OF_LATITUDE * 
		SIMPLIFIED_SQUARE_LONGITUDE_SIZE * 
		LENGTH_OF_A_DEGREE_OF_LONGITUDE, // sqkm

	serverReady = false;


var mean = function (values) {
	return _.reduce(values, function (memo, num) { return memo + num; }, 0.0) / values.length;
}


var median = function (values) {
	// Thanks to http://caseyjustus.com/finding-the-median-of-an-array-with-javascript
    values.sort(function(a,b) { return a - b; });
    var half = Math.floor(values.length / 2);
    return (values.length % 2 == 0) ? values[half] : (values[half - 1] + values[half]) / 2.0;
}


// Estimates the response time of a generic incident in a square; it expects
// incidentsNotImpacted to be an array of incidents not impacted from the
// stations closure, hence relevant for calculation
var estimateSquareResponseTime = async.memoize(function (longitude, latitude, closedStations, callback) {
	var MIN_NO_OF_INCIDENTS = 1,
		results = [ ],
		foundEnough = false,
		m = 0;
	async.whilst(
		function () { return !foundEnough; }, 
		function (whilstCallback) {
			mongo.collection('incidentsData')
				.find({ $and: [
							{ simplifiedLongitude: { $gte: longitude - m * SIMPLIFIED_SQUARE_LONGITUDE_SIZE } },
							{ simplifiedLongitude: { $lt: longitude + (m + 1) * SIMPLIFIED_SQUARE_LONGITUDE_SIZE } },
							{ simplifiedLatitude: { $lte: latitude + m * SIMPLIFIED_SQUARE_LATITUDE_SIZE } },
							{ simplifiedLatitude: { $gt: latitude - (m + 1) * SIMPLIFIED_SQUARE_LATITUDE_SIZE } },
							{ firstPumpStation: { $nin: closedStations } }, 
						] }, 
					{ firstPumpTime: 1 })
				.toArray(function (err, queryResults) {
					results = queryResults;
					foundEnough = results.length >= MIN_NO_OF_INCIDENTS;
					m++;
					whilstCallback(null);
				});
		}, 
		function (err) {
			console.log("found with m = " + --m);
			callback(null, mean(_.map(results, function (i) { return i.firstPumpTime; })));
		}
	);
}, function (longitude, latitude, closedStations) {
	return longitude + '_' + latitude + (closedStations.length > 0 ? '-minus-' + closedStations.join('_') : '');
});


var getBoroughResponseTimes = async.memoize(function (borough, closedStations, callback) {
	log("Calculating for the first time getBoroughResponseTimes for " + borough + " with closed stations: " + closedStations.join(", "));
	mongo.collection('incidentsData')
		.find({ $and: [ { borough: borough } , { firstPumpStation: { $nin: closedStations } } ]}, { firstPumpTime: 1 , simplifiedLongitude: 1, simplifiedLatitude: 1 })
		.toArray(function (err, incidentsNotImpacted) {
			mongo.collection('incidentsData')
				.find({ $and: [ { borough: borough } , { firstPumpStation: { $in: closedStations } } ]}, { simplifiedLongitude: 1, simplifiedLatitude: 1 })
				.toArray(function (err, incidentsImpacted) {
					var oldTimings = _.map(incidentsNotImpacted, function (i) { return i.firstPumpTime; });
					async.reduce(
						_.map(_.values(_.groupBy(incidentsImpacted, function (i) { return i.simplifiedLongitude + '_' + i.simplifiedLatitude; })), function (incidents) { return { noOfIncidents: incidents.length, longitude: incidents[0].simplifiedLongitude, latitude: incidents[0].simplifiedLatitude }; }),
						[ ],
						function (memo, coordinates, callback) {
							estimateSquareResponseTime(coordinates.longitude, coordinates.latitude, closedStations, function (err, newResponseTime) {
								callback(null, memo.concat(_.map(Array(coordinates.noOfIncidents + 1).join(1).split(''), function() { return newResponseTime; })));
							});
						},
						function (err, newTimings) {
							callback(null, oldTimings.concat(newTimings));
						}
					);
			});	
	});
}, function (borough, closedStations) {
	return borough + (closedStations.length > 0 ? '-minus-' + closedStations.join('_') : '');
});


var getBoroughHist = async.memoize(function (borough, closedStations, callback) {
	log("Calculating for the first time getBoroughHist for " + borough + " with closed stations: " + closedStations.join(", "));
	getBoroughResponseTimes(borough, closedStations, function (err, responseTimes) {
		var BIN_SIZE = 60, // seconds
			maxResponseTime = Math.max.apply(null, responseTimes),
			results = [ ];
		for (var timeMin = 0; timeMin <= maxResponseTime; timeMin += BIN_SIZE) {
			var timeMax = timeMin + BIN_SIZE;
			results.push({
				timeMin: timeMin,
				timeMax: timeMax,
				incidents: _.filter(responseTimes, function (r) { return (r >= timeMin) && (r < timeMax); }).length,
			});
		}
		callback(null, results);
	});
}, function (borough, closedStations) {
	return borough + (closedStations.length > 0 ? '-minus-' + closedStations.join('_') : '');
});


var getBoroughResponseTime = async.memoize(function (borough, closedStations, callback) {
	log("Calculating for the first time getBoroughResponseTime for " + borough + " with closed stations: " + closedStations.join(", "));
	getBoroughResponseTimes(borough, closedStations, function (err, result) {
		callback(err, mean(result));
	});
}, function (borough, closedStations) {
	return borough + (closedStations.length > 0 ? '-minus-' + closedStations.join('_') : '');
});


/*  The function loads the necessary detailed incident data, calculates the
    specified borough's score vs time and population and then calls back
    callback(err, boroughscore) */
var getBoroughScore = async.memoize(function (borough, closedStations, callback) {
	log("Calculating for the first time getBoroughScore for " + borough + " with closed stations: " + closedStations.join(", "));
	var A = 0.75;
	getBoroughResponseTimes(borough, closedStations, function (err, responseTimes) {
		mongo.collection('incidentsData')
			.find({ borough: borough })
			.toArray(function (err, incidentsData) {
				var medianResponseTimes = median(_.map(responseTimes, function (x) { return x / 60; })),
					medianFootfall = median(_.map(incidentsData, function (i) { return i.footfall; }));
				callback(null, Math.pow(medianResponseTimes, A) * 
					Math.pow(Math.log(medianFootfall + 2) / Math.log(10), 1 - A));
		});
	});
}, function (borough, closedStations) {
	return borough + (closedStations.length > 0 ? '-minus-' + closedStations.join('_') : '');
});


var getAllBoroughsScores = async.memoize(function (closedStations, callback) {
	log("Calculating for the first time getAllBoroughsScores for closed stations: " + closedStations.join(", "));
	var results = [ ];
	async.eachSeries(BOROUGHS_NAMES, function (borough, seriesCallback) {
		var footfallDensity = 0;
		var census = { };
		var responseTime = 0;
		var score = 0;
		async.parallel([
			function (callback) {
				mongo.collection('incidentsData').find({ borough: borough }, { footfall: 1 }).toArray(function (err, items) {
					footfallDensity = Math.round(median(_.map(items, function (i) { return i.footfall / AREA_OF_ONE_SIMPLIFIED_SQUARE; })), 0);
					callback(null);
				});
			},
			function (callback) {
				mongo.collection('censusData').find({ borough: borough }).toArray(function (err, items) {
					census = items[0];
					callback(null);
				});
			},
			function (callback) {
				getBoroughResponseTime(borough, closedStations, function (err, result) {
					responseTime = result;
					callback(null);
				});
			},
			function (callback) {
				getBoroughScore(borough, closedStations, function (err, result) {
					score = result;
					callback(null);
				});
			},
		], function (err, parallelResults) {
			results.push({
				borough: borough,
				responseTime: responseTime,
				score: score,
				footfallDensity: footfallDensity,
				totalPopulation: census.totalPopulation,
				areaSqKm: census.areaSqKm,
				populationDensity: census.populationDensity,
			});
			seriesCallback(null);
		});
	}, function (err) {
		callback(null, results);
	});
}, function (closedStations) {
	return closedStations.join('_');
});


var log = function (s) {
	var entryDate = new Date();
	console.log(entryDate.getFullYear() + "/" + (entryDate.getMonth() < 9 ? '0' : '') + (entryDate.getMonth() + 1) + "/" + (entryDate.getDate() < 10 ? '0' : '') + entryDate.getDate() + " " + (entryDate.getHours() < 10 ? '0' : '') + entryDate.getHours() + ":" + (entryDate.getMinutes() < 10 ? '0' : '') + entryDate.getMinutes() + ":" + (entryDate.getSeconds() < 10 ? '0' : '') + entryDate.getSeconds() + " - " + s);
}

var cacheAll = function (callback) {
	async.series([
		function (seriesCallback) {
			log("Caching getBoroughResponseTime(borough)...");
			async.eachSeries(BOROUGHS_NAMES, function (b, callback) { getBoroughResponseTime(b, [ ], callback); }, seriesCallback);
		},
		function (seriesCallback) {
			log("Caching getBoroughResponseTime(borough, closed stations) for all boroughs and the stations selected by the Mayor...");
			async.eachSeries(BOROUGHS_NAMES, function (b, callback) { getBoroughResponseTime(b, STATIONS_FACING_CLOSURE_NAMES, callback) }, seriesCallback);	
		},
		function (seriesCallback) {
			log("Caching getBoroughScore(borough) for all boroughs...");
			async.eachSeries(BOROUGHS_NAMES, function (b, callback) { getBoroughScore(b, [ ], callback) }, seriesCallback);	
		},
		function (seriesCallback) {
			log("Caching getBoroughScore(borough, closed stations) for all boroughs and the stations selected by the Mayor...");
			async.eachSeries(BOROUGHS_NAMES, function (b, callback) { getBoroughScore(b, STATIONS_FACING_CLOSURE_NAMES, callback) }, seriesCallback);	
		},
		function (seriesCallback) {
			log("Caching getBoroughHist(borough) for all boroughs...");
			async.eachSeries(BOROUGHS_NAMES, function (b, callback) { getBoroughHist(b, [ ], callback) }, seriesCallback);	
		},
		function (seriesCallback) {
			log("Caching getBoroughHist(borough, closed stations) for all boroughs and the stations selected by the Mayor...");
			async.eachSeries(BOROUGHS_NAMES, function (b, callback) { getBoroughHist(b, STATIONS_FACING_CLOSURE_NAMES, callback) }, seriesCallback);	
		},
		function (seriesCallback) {
			log("Caching getAllBoroughsScores()...");
			getAllBoroughsScores([ ], seriesCallback);	
		},
		function (seriesCallback) {
			log("Caching getAllBoroughsScores() for the stations selected by the Mayor......");
			getAllBoroughsScores(STATIONS_FACING_CLOSURE_NAMES, seriesCallback);	
		},
	], function (err, results) {
		log("Caching completed.");
		serverReady = true;
		if (callback) callback(err);
	});
};


var server = restify.createServer({
  name: 'ODI - FNR Analysis server',
});
server.use(restify.queryParser());
server.use(restify.jsonp());


server.get('/getBoroughResponseTime', function (req, res, next) {
	if (!serverReady) return next(new Error("The server is not ready, please try again later."));
	req.query.close = [ ].concat(req.query.close || [ ]);
	if (!req.query.borough || !_.contains(BOROUGHS_NAMES, req.query.borough)) 
		return next(new Error("The borough is either not specified or not recognised. Have you checked the spelling?"));
	if (req.query.close.length > 0 && _.some(req.query.close, function (s) { return !_.contains(STATIONS_NAMES, s); }))
		return next(new Error("One or more of the specified stations are not recognised. Have you checked the spelling?"));
	getBoroughResponseTime(req.query.borough, req.query.close, function (err, result) {
		res.send(200, { response: result });
		return next();
	});
});


server.get('/getBoroughScore', function (req, res, next) {
	if (!serverReady) return next(new Error("The server is not ready, please try again later."));
	req.query.close = [ ].concat(req.query.close || [ ]);
	if (!req.query.borough || !_.contains(BOROUGHS_NAMES, req.query.borough)) 
		return next(new Error("The borough is either not specified or not recognised. Have you checked the spelling?"));
	if (req.query.close.length > 0 && _.some(req.query.close, function (s) { return !_.contains(STATIONS_NAMES, s); }))
		return next(new Error("One or more of the specified stations are not recognised. Have you checked the spelling?"));
	getBoroughScore(req.query.borough, req.query.close, function (err, result) {
		res.send(200, { response: result });
		return next();
	});
});


server.get('/getBoroughHist', function (req, res, next) {
	if (!serverReady) return next(new Error("The server is not ready, please try again later."));
	req.query.close = [ ].concat(req.query.close || [ ]);
	if (!req.query.borough || !_.contains(BOROUGHS_NAMES, req.query.borough)) 
		return next(new Error("The borough is either not specified or not recognised. Have you checked the spelling?"));
	if (req.query.close.length > 0 && _.some(req.query.close, function (s) { return !_.contains(STATIONS_NAMES, s); }))
		return next(new Error("One or more of the specified stations are not recognised. Have you checked the spelling?"));
	getBoroughHist(req.query.borough, req.query.close, function (err, result) {
		res.send(200, { response: result });
		return next();
	});
});


server.get('/getAllBoroughsScores', function (req, res, next) {
	if (!serverReady) return next(new Error("The server is not ready, please try again later."));
	req.query.close = [ ].concat(req.query.close || [ ]);
	if (req.query.close.length > 0 && _.some(req.query.close, function (s) { return !_.contains(STATIONS_NAMES, s); }))
		return next(new Error("One or more of the specified stations are not recognised. Have you checked the spelling?"));
	getAllBoroughsScores(req.query.close, function (err, result) {
		res.send(200, { response: result });
		return next();
	});
});


var port = argv.port || process.env.PORT || 8080;
server.listen(port);
log("The server is listening on port " + port + ".");
cacheAll();

/*
mongo.collection("incidentsData").find({ }, { limit: 1 }).toArray(function (err, items) {
	var i = items[0];
	console.log(i);
	estimateSquareResponseTime(i.simplifiedLongitude, i.simplifiedLatitude, [ ], function (err, result) {
		console.log("The new response time is: " + result);		
	});
});
*/

// getBoroughResponseTime("Harrow", [ "Harrow" ], function (err, result) { console.log(result); });

// http://localhost:8080/getAllBoroughsScores?close=Harrow
// - memory only 14s
// - db 36s
