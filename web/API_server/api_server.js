var _ = require('underscore'),
	argv = require('optimist') 
		.usage('Usage: $0 [--port portNumber]')
		// .demand([ 'port' ])
		.alias('port', 'p')
		.argv,
	csv = require('csv'),
	fs = require('fs'),
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

    incidentsData = [ ];
    censusData = [ ];
    serverReady = false;


// TODO: what you see below necessary is necessary with D3, as all columns are
// imported as string for some reason not yet investigated 
var forceColumnsToFloat = function (columnNames, a) {
	_.each(a, function (record) {
		_.each(columnNames, function (columnName) {
			record[columnName] = parseFloat(record[columnName]);
		});
	});
}


var loadAllIncidents = function (callback) {
	log("Loading incident data...");
	incidentsData = [ ];
    csv()
		.from.stream(fs.createReadStream(__dirname + '/data.csv.gz').pipe(zlib.createUnzip()), {
            columns: true
        })
        .on('record', function (row, index) {
        	incidentsData.push(row);
        })
        .on('end', function (count) {
			forceColumnsToFloat([ 'firstPumpTime', 'simplifiedLatitude', 'simplifiedLongitude', 'footfall' ], incidentsData);
			log("Completed loading incidents data.");
        	log("Loading census data...");
			censusData = [ ];
		    csv()
				.from.stream(fs.createReadStream(__dirname + '/census.csv.gz').pipe(zlib.createUnzip()), {
		            columns: true
		        })
		        .on('record', function (row, index) {
		        	censusData.push(row);
		        })
		        .on('end', function (count) {
					forceColumnsToFloat([ 'Total Population (Thousands)', 'Area (Square km)', 'Population per Sq/Km' ], censusData);
					censusData = _.reduce(censusData, function (memo, row) { 
						memo[row.borough] = {
							totalPopulation: row.populationThousands * 1000,
							areaSqKm: row.areaSqKm,
							populationDensity: row.populationDensity,
						};
						return memo;
					} , { });
					log("Completed loading census data.");
					if (callback) callback (null);
				});
        });
};


var mean = function (values) {
	return _.reduce(values, function (memo, num) { return memo + num; }, 0.0) / values.length;
}


var median = function (values) {
	// Thanks to http://caseyjustus.com/finding-the-median-of-an-array-with-javascript
    values.sort(function(a,b) { return a - b; });
    var half = Math.floor(values.length / 2);
    return (values.length % 2 == 0) ? values[half] : (values[half - 1] + values[half]) / 2.0;
}


var getBoroughsByFirstResponderM = _.memoize(function () {
	results = { };
	_.each(STATIONS_NAMES, function (s) {
		results[s] = _.unique(_.map(_.filter(incidentsData, function (i) { return s == i.firstPumpStation; }), function (i) { return i.borough; })).sort();
	})
	return results;
});


var getBoroughResponseTimesM = _.memoize(function (borough, closedStations) {

	// Estimates the response time of a generic incident in a square; it expects
	// boroughIncidentsNotImpacted to be an array of incidents not impacted from 
	// the stations closure, hence relevant for calculation
	var estimateSquareResponseTime = _.memoize(function (longitude, latitude) {
		var MIN_NO_OF_INCIDENTS = 1;
		var results = [ ];
		var foundEnough = false;
		for (var m = 0; !foundEnough; m++) {
			results = _.filter(boroughIncidentsNotImpacted, function (i) {
				return (i.simplifiedLongitude >= longitude - m * SIMPLIFIED_SQUARE_LONGITUDE_SIZE) &&
				(i.simplifiedLongitude < longitude + (m + 1) * SIMPLIFIED_SQUARE_LONGITUDE_SIZE) &&
				(i.simplifiedLatitude <= latitude + m * SIMPLIFIED_SQUARE_LATITUDE_SIZE) &&
				(i.simplifiedLatitude > latitude - (m + 1) * SIMPLIFIED_SQUARE_LATITUDE_SIZE);
			});
			foundEnough = results.length >= MIN_NO_OF_INCIDENTS;
		}
		return mean(_.map(results, function (i) { return i.firstPumpTime; }));
	}, function (longitude, latitude) {
		return longitude + '_' + latitude;
	});

	closedStations = ([ ].concat(closedStations));
	log("Calculating for the first time getBoroughResponseTimesM for " + borough + " with closed stations: " + closedStations.join(", "));
	var boroughIncidents = _.filter(incidentsData, function (i) { return i.borough == borough; }),
		boroughIncidentsNotImpacted = (closedStations.length == 0 ? boroughIncidents : _.filter(boroughIncidents, function (i) { return !_.contains(closedStations, i.firstPumpStation); })),
		boroughIncidentsImpacted = (closedStations.length == 0 ? [ ] : _.filter(boroughIncidents, function (i) { return _.contains(closedStations, i.firstPumpStation); })),
		oldTimings = _.map(boroughIncidentsNotImpacted, function (i) { return i.firstPumpTime; }),
		newTimings = _.reduce(_.values(_.groupBy(boroughIncidentsImpacted, function (i) { return i.simplifiedLongitude + '_' + i.simplifiedLatitude; })), 
			function (memo, incidentsInSameSquare) {
				var newResponseTime = estimateSquareResponseTime(incidentsInSameSquare[0].simplifiedLongitude, incidentsInSameSquare[0].simplifiedLatitude, closedStations);
				// See http://stackoverflow.com/a/19290390/1218376 for the strange expression below
				return memo.concat(_.map(Array(incidentsInSameSquare.length + 1).join(1).split(''), function() { return newResponseTime; }));
			},
			[ ]);
	return oldTimings.concat(newTimings);
}, function (borough, closedStations) {
	closedStations = !closedStations ? [ ] : [ ].concat(closedStations).sort();
	return borough + (closedStations.length > 0 ? '-minus-' + closedStations.join('_') : '');
});


var getBoroughHistM = _.memoize(function (borough, closedStations) {
	closedStations = [ ].concat(closedStations || [ ]);
	log("Calculating for the first time getBoroughHistM for " + borough + " with closed stations: " + closedStations.join(", "));
	var BIN_SIZE = 60, // seconds
		responseTimes = getBoroughResponseTimesM(borough, closedStations),
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
	return results;
}, function (borough, closedStations) {
	closedStations = [ ].concat(closedStations || [ ]);
	return borough + (closedStations.length > 0 ? '-minus-' + closedStations.join('_') : '');
});


var getBoroughResponseTimeM = _.memoize(function (borough, closedStations) {
	closedStations = [ ].concat(closedStations || [ ]);
	return mean(getBoroughResponseTimesM(borough, closedStations));
}, function (borough, closedStations) {
	closedStations = [ ].concat(closedStations || [ ]);
	return borough + (closedStations.length > 0 ? '-minus-' + closedStations.join('_') : '');
});


/* Like getBoroughScore below, but assumes that the incidents data for
   the borough has been loaded already */
var getBoroughScoreM = _.memoize(function (borough, closedStations) {
	closedStations = [ ].concat(closedStations || [ ]);
	log("Calculating for the first time getBoroughScoreM for " + borough + " with closed stations: " + closedStations.join(", "));
	var A = 0.75,
		medianResponseTimes = median(_.map(getBoroughResponseTimesM(borough, closedStations), function (x) { return x / 60; })),
		medianFootfall = median(_.map(_.filter(incidentsData, function (i) { return i.borough == borough; }), function (i) { return i.footfall; }));
	return Math.pow(medianResponseTimes, A) * 
		Math.pow(Math.log(medianFootfall + 2) / Math.log(10), 1 - A);
}, function (borough, closedStations) {
	closedStations = [ ].concat(closedStations || [ ]);
	return borough + (closedStations.length > 0 ? '-minus-' + closedStations.join('_') : '');
});


// Just for testing, prints out a .csv on the JavaScript console
var getAllBoroughsScoresM = _.memoize(function (closedStations) {
	closedStations = [ ].concat(closedStations || [ ]);
	var results = [ ];
	_.each(BOROUGHS_NAMES, function (borough) {
		results.push({
			borough: borough,
			responseTime: getBoroughResponseTimeM(borough, closedStations),
			score: getBoroughScoreM(borough, closedStations),
			footfallDensity: Math.round(median(_.map(_.filter(incidentsData, function (i) { return i.borough == borough; }), function (i) { return i.footfall / AREA_OF_ONE_SIMPLIFIED_SQUARE; })), 0),
			totalPopulation: censusData[borough].totalPopulation,
			areaSqKm: censusData[borough].areaSqKm,
			populationDensity: censusData[borough].populationDensity,
		});
	});
	return results;
}, function (closedStations) {
	closedStations = [ ].concat(closedStations || [ ]);
	return closedStations.join('_');
});


// Just for testing, prints out a .csv on the JavaScript console
var getAllBoroughsScoresCSV = function (closedStations) {
	log("It can take a while when calculated for the first time...");
	var results = getAllBoroughsScoresM(closedStations);
	console.log(_.keys(results[0]).join(","));
	_.each(results, function (r) {
		console.log(_.values(r).join(","));
	});
};


var log = function (s) {
	var entryDate = new Date();
	console.log(entryDate.getFullYear() + "/" + (entryDate.getMonth() < 9 ? '0' : '') + (entryDate.getMonth() + 1) + "/" + (entryDate.getDate() < 10 ? '0' : '') + entryDate.getDate() + " " + (entryDate.getHours() < 10 ? '0' : '') + entryDate.getHours() + ":" + (entryDate.getMinutes() < 10 ? '0' : '') + entryDate.getMinutes() + ":" + (entryDate.getSeconds() < 10 ? '0' : '') + entryDate.getSeconds() + " - " + s);
}


var server = restify.createServer({
  name: 'ODI - FNR Analysis server',
});
server.use(restify.queryParser());
server.use(restify.jsonp());

// TODO: check if this is redundant, as the same information may be
// statically distributed with the client-side code
server.get('/getBoroughsByFirstResponder', function (req, res, next) {
	if (!serverReady) return next(new Error("The server is not ready, please try again later."));
	res.send(200, { response: getBoroughsByFirstResponderM() })
	return next();
});

server.get('/getBoroughResponseTime', function (req, res, next) {
	if (!serverReady) return next(new Error("The server is not ready, please try again later."));
	req.query.close = [ ].concat(req.query.close || [ ]);
	if (!req.query.borough || !_.contains(BOROUGHS_NAMES, req.query.borough)) 
		return next(new Error("The borough is either not specified or not recognised. Have you checked the spelling?"));
	if (req.query.close.length > 0 && _.some(req.query.close, function (s) { return !_.contains(STATIONS_NAMES, s); }))
		return next(new Error("One or more of the specified stations are not recognised. Have you checked the spelling?"));
	res.send(200, { response: getBoroughResponseTimeM(req.query.borough, req.query.close) });
	return next();
});

server.get('/getBoroughScore', function (req, res, next) {
	if (!serverReady) return next(new Error("The server is not ready, please try again later."));
	req.query.close = [ ].concat(req.query.close || [ ]);
	if (!req.query.borough || !_.contains(BOROUGHS_NAMES, req.query.borough)) 
		return next(new Error("The borough is either not specified or not recognised. Have you checked the spelling?"));
	if (req.query.close.length > 0 && _.some(req.query.close, function (s) { return !_.contains(STATIONS_NAMES, s); }))
		return next(new Error("One or more of the specified stations are not recognised. Have you checked the spelling?"));
	res.send(200, { response: getBoroughScoreM(req.query.borough, req.query.close) });
	return next();
});

server.get('/getAllBoroughsScores', function (req, res, next) {
	if (!serverReady) return next(new Error("The server is not ready, please try again later."));
	req.query.close = [ ].concat(req.query.close || [ ]);
	if (req.query.close.length > 0 && _.some(req.query.close, function (s) { return !_.contains(STATIONS_NAMES, s); }))
		return next(new Error("One or more of the specified stations are not recognised. Have you checked the spelling?"));
	res.send(200, { response: getAllBoroughsScoresM(req.query.close) });
	return next();
});

server.get('/getBoroughHist', function (req, res, next) {
	if (!serverReady) return next(new Error("The server is not ready, please try again later."));
	req.query.close = [ ].concat(req.query.close || [ ]);
	if (!req.query.borough || !_.contains(BOROUGHS_NAMES, req.query.borough)) 
		return next(new Error("The borough is either not specified or not recognised. Have you checked the spelling?"));
	if (req.query.close.length > 0 && _.some(req.query.close, function (s) { return !_.contains(STATIONS_NAMES, s); }))
		return next(new Error("One or more of the specified stations are not recognised. Have you checked the spelling?"));
	res.send(200, { response: getBoroughHistM(req.query.borough, req.query.close) });
	return next();
});

var cacheAll = function (callback) {
	loadAllIncidents(function () {
		log("Caching getBoroughsByFirstResponderM()...");
		getBoroughsByFirstResponderM()	
		log("Caching getBoroughResponseTimeM(borough)...");
		_.each(BOROUGHS_NAMES, function (b) { getBoroughResponseTimeM(b) });	
		log("Caching getBoroughResponseTimeM(borough, closed stations) for all boroughs and the stations selected by the Mayor...");
		_.each(BOROUGHS_NAMES, function (b) { getBoroughResponseTimeM(b, STATIONS_FACING_CLOSURE_NAMES) });	
		log("Caching getBoroughScoreM(borough) for all boroughs...");
		_.each(BOROUGHS_NAMES, function (b) { getBoroughScoreM(b) });	
		log("Caching getBoroughScoreM(borough, closed stations) for all boroughs and the stations selected by the Mayor...");
		_.each(BOROUGHS_NAMES, function (b) { getBoroughScoreM(b, STATIONS_FACING_CLOSURE_NAMES) });	
		log("Caching getBoroughHistM(borough) for all boroughs...");
		_.each(BOROUGHS_NAMES, function (b) { getBoroughHistM(b) });	
		log("Caching getBoroughHistM(borough, closed stations) for all boroughs and the stations selected by the Mayor...");
		_.each(BOROUGHS_NAMES, function (b) { getBoroughHistM(b, STATIONS_FACING_CLOSURE_NAMES) });	
		log("Caching getAllBoroughsScoresM()...");
		getAllBoroughsScoresM();	
		log("Caching completed.");
		serverReady = true;
		if (callback) callback(null);
	});;
};

cacheAll();
var port = argv.port || process.env.PORT || 8080;
server.listen(port);
log("The server is listening on port " + port + ".");
