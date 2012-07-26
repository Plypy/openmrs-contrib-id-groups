var https = require('https'),
	util = require('util'),
	xml2js = require('xml2js'),
	emitter = require('events').EventEmitter,
	Common = require(global.__apppath+'/openmrsid-common'),
	db = Common.db,
	log = Common.logger.add('provisioning');

var gaUsername, gaPassword, gaDomain; // connection information stored here

var connection = new emitter; // emits connected and disconnected events 
	authToken = '';

exports.connectionStatus = 0; // 0 = disconnected, 1 = connecting, 2 = connected, -1 = disabled
	
var GAError = function(message, status, constr) {
	Error.captureStackTrace(this, constr || this);
	this.status = status || 1;
	this.message = message+' ('+status+')' || 'Google Apps API Error';
}
util.inherits(GAError, Error);
GAError.prototype.name = 'GAError';

var parseError = function(status, data, callback) {
	var status, message; 
	
	// interpret HTTP status code
	if (status == 200) return callback(null); // no error, skip the rest of this error code
	else if (status == 201) {message = undefined; status = undefined;} // created
	else if (status == 304) {message = undefined; status = undefined;} // resource hasn't changed
	else if (status == 400) {message = 'Bad request to GData.'; status = 400;}
	else if (status == 401) {message = 'Unauthorized resource requested.'; status = 401;}
	else if (status == 403) {message = 'Unsupported parameter or failed authorization.'; status = 403;}
	else if (status == 404) {message = 'GData resource not found.'; status = 404;}
	else if (status == 409) {message = 'Resource version number conflict.'; status = 409;}
	else if (status == 410) {message = 'Requested GData resource is no longer available.'; status = 410;}
	else if (status == 500) {message = 'Internal GData server error.'; status = 500;}
	
	// parse GData error
	if (data && data.indexOf('<AppsForYourDomainErrors>') > -1) { // if Error msg exists in response
		var parser = new xml2js.Parser({mergeAttrs: true});
		parser.parseString(data, function(err, result){
			log.trace('GData error detected');
			if (err) return callback(err);
			var code = result.error.errorCode;
			var reason = result.error.reason;
			
			if (code == 1303) { // "entity not valid" - returns for addresses that have no subscriptions
				log.trace('GData error was an "entity not valid" e.g. not important');
				return callback(null); // this wasn't a meaningful error
			}	
			else
				return callback(new GAError(message+' (GData error '+code+': '+reason+')', status)); // send both errors
		});
		
	}
	else {
		if (message || status) // only if an HTTP error has occured
			return callback(new GAError(message, status)); // no GData error
		else return callback();
	}
};
	
	
// AUTHENTICATION & CONNECTION // - keeps an up-to-date token available from GA

var connect = function(callback) {
	if (typeof callback != 'function') callback = function(err){if (err) log.error(err);}
	
	var finish = function(error, newToken) { // called once done
		
		authToken = newToken;
		connection.emit('connected');
		exports.connectionStatus = 2; // ready to accept calls
		
		setTimeout(function(){ // get a new token in 20 hrs (token expires in 24)
			exports.reconnect();
		}, 1000*60*60*20);
		
		callback();
	};
	
	connection.emit('disconnected');
	exports.connectionStatus = 1; // getting a new token
	
	// connect to DB and get username/password/domain
	db.find('GroupsConf', {key: ['username', 'password', 'domain']}, function(err, instances){
		if (err) return callback(err);
		
		// if paramaters are incorrect, abort connection
		if (instances.length != 3) {
			exports.connectionStatus = -1;
			connection.emit('disabled');
			return log.warn('Unable to connect to the Provisioning API: Login paramaters not found in DB. Aborting connection...');
		}
		
		// get user/pass/domain from DB data
		instances.forEach(function(pref){
			if (pref.key == 'username') gaUsername = pref.value;
			else if (pref.key == 'password') gaPassword = pref.value;
			else if (pref.key == 'domain') gaDomain = pref.value;
		});
		
		// prepare the login request
		var options = {
			host: 'google.com',
			port: '443',
			path: '/accounts/ClientLogin',
			method: 'POST',
			headers: {'Content-Type': 'application/x-www-form-urlencoded'}
		};
		var data = '';
		
		// send the login req
		var req = https.request(options, function(res) {
			log.info('Authenticating to Google Apps as '+gaUsername+'.');
			log.trace('GA ClientLogin Status: '+res.statusCode);
			//log.trace('GA ClientLogin Headers: '+JSON.stringify(res.headers));
			
			res.setEncoding('utf8');
			
			res.on('data', function(chunk){ // collect response data
				//log.trace('GA ClientLogin Body Chunk: '+chunk);
				data += chunk;
			});
			
			res.on('end', function() { // extract auth token from response and call finish
				//log.trace('all data received: '+data);
				parseError(res.statusCode, data, function(error){
					if (error) {
						return callback(error);
					}
					
					var auth = /(Auth=)(\S*)/.exec(data)[0]; // parse token from data
					log.trace('auth token: '+auth);
					
					authToken = auth; // update global token
					connection.emit('connected');
					exports.connectionStatus = 2; // now ready to accept calls
					
					setTimeout(connect, 1000*60*60*20); // get a new token in 20 hrs (token expires in 24)
					
					callback();
				});
			});
		});
		
		req.on('error', function(e) {
			log.error('GA ClientLogin Failure: '+e.message);
			return callback(e);
		});
		
		req.write('&Email=' // POST login credentials
			+encodeURIComponent(gaUsername)
			+'&Passwd='+encodeURIComponent(gaPassword)
			+'&accountType=HOSTED&service=apps');
		req.end();
	});
};

var verify = function(callback) { // verify connection to GA (in order to make calls)
	callback = (!callback) ? new Function : callback;
	var timeout = function() {
		exports.connectionStatus = 0;
		log.error('Timed out while waiting for GA client to reconnect');
		callback(new GAError('Unable to verify connection to Google Apps.'));
	}
	
	if (exports.connectionStatus == 2) { // client already connected
		exports.connectionStatus = 2;
		log.trace('GA already connected');
		callback();
	}
	else if (exports.connectionStatus == -1) { // connection disabled
		exports.connectionStatus = -1;
		callback(new Error('Google Groups connection disabled.'));
	}
	else { // in the process of reconnecting OR no connection found
		log.debug('no GA connection found; status = waiting for reconnect');
		
		if (exports.connectionStatus == 0) connect(function(error){
			if (error) return callback(error);
			exports.connectionStatus = 2;
		}); // connect if not connected at all
		
		var time = setTimeout(timeout, 5000);
		connection.once('connected', function(){
			exports.connectionStatus = 2;
			log.trace('now connected, auth token in memory');
			clearTimeout(time);
			callback();
		});
		connection.once('disabled', function(){
			exports.connectionStatus = -1;
			clearTimeout(time);
			callback(new Error('Google Groups connection disabled.'));
		})
	}
}


// API CALLS //

var setOptions = function(method, path) { // return a configured options object for HTTP request
	var out = {
		host: 'apps-apis.google.com',
		port: 443,
		path: path,
		method: method,
		headers: {'Content-Type': 'application/atom+xml',
			'Authorization': 'GoogleLogin '+authToken}
	};
	//log.trace('request options: '+JSON.stringify(out));
	return out;
};

var parseGroupFormat = function(input, callback) {
	if (!callback instanceof Function) callback = new Function;
	var out = []; // will populate with groups
	
	// if no occupied entries in input (no groups) return an empty group array
	if (!input.entry[0]) return callback(out);
	
	// otherwise, parse each entry for group props
	// each group appears as an "entry" in GData
	input.entry.forEach(function(element, i, array){
		var grp = {};
		element['apps:property'].forEach(function(prop){
			if (prop.name == 'groupId') {
				grp.address = prop.value;
				grp.urlName = grp.address.replace(/@.+$/, '').toLowerCase(); 
			}
			else if (prop.name == 'groupName') grp.name = prop.value;
			else if (prop.name == 'emailPermission') grp.emailPermission = prop.value;
			else if (prop.name == 'description') grp.description = prop.value;
			else if (prop.name == 'permissionPreset') grp.permissionPreset = prop.value;
			else if (prop.name == 'directMember') grp.directMember = prop.value;
		});
		out.push(grp);
	}); // now finished
	callback(out);
};


/*
	Returns object containing groups for GA domain:
	[
		{
			address: group@domain.com
			name: Group Name
			emailPermission: Member
			permissionPreset: Custom
			description: Text Description
		} … etc.
	]
*/
exports.getAllGroups = function(callback) {
	if (!callback instanceof Function) callback = new Function;
	verify(function(err){
		if (err) return callback(err);
		
		var options = setOptions('GET', '/a/feeds/group/2.0/'+encodeURIComponent(gaDomain));
		
		var req = https.get(options, function(res) {
			data = '';
			res.on('data', function(chunk) {
				//log.trace('chunk: '+chunk);
				data += chunk;
			});
			
			res.on('end', function(err) {
				if (err) return callback(err);
				log.trace('getAllGroups api call closed');
				
				parseError(res.statusCode, data, function(err){
					if (err) return callback(err);
					var parser = new xml2js.Parser({mergeAttrs: true});
					parser.parseString(data, function(err, result) {
						if (err) return callback(err);
						
						var finish = function(out) { // called once all have been parsed
							callback(null, out); // all done!
						}
						
						parseGroupFormat(result, finish); // parse THIS json into the data we need
							
					});
				});
			});
		});
		req.on('error', function(err) {
			log.error('GA getAllGroups Failure: '+err.message);
			return callback(err);
		});
	});
}

/*
	Returns object for an email address's (user's) groups:
	[ {address: group1@domain.com, name: 'GROUP_ONE', emailPermission: 'Member', permissionPreset: 'Custom', Description: 'Text'},
	  {address: group2@domain.com, name: 'GROUP_TWO', emailPermission: 'Member', permissionPreset: 'Custom', Description: 'Text'}]
*/
exports.getGroupsByEmail = function(email, callback) {
	if (!callback instanceof Function) callback = new Function;
	verify(function(err){
		if (err) return callback(err);
		
		var options = setOptions('GET', 'https://apps-apis.google.com/a/feeds/group/2.0/'+encodeURIComponent(gaDomain)+'/?member='+email);
		var req = https.get(options, function(res) {		
			var data = '';
			res.on('data', function(chunk) {
				log.trace('chunk: '+chunk); // this was slowing down the logger :(
				data += chunk;
			});
			
			res.on('end', function(err) {
				if (err) return callback(err);
				log.trace('getGroupsByEmail api call closed');
				parseError(res.statusCode, data, function(err){ // respond to GData API error
					if (err) return callback(err);
				
					var parser = new xml2js.Parser({mergeAttrs: true});
					parser.parseString(data, function(err, result) { // convert xml response to traversable json
						if (err) return callback(err);
						
						var finish = function(out){
							callback(null, out);
						};
						
						// force results to be an array - if user has one group, result will be a string and forEach() will fail
						if (!(result.entry instanceof Array)) result.entry = [result.entry];
						parseGroupFormat(result, finish);
						
					});
				});
			});
		});
		req.on('error', function(err) {
			log.error('GA getGroupsByEmail Failure: '+err.message);
			return callback(err);
		});
	});
};

/*
	Adds an email address to specified group, returning:
	{"apps:property": {
    	"name": "memberId",
    	"value": "ewilliams995@gmail.com"
    }}
	
*/
exports.addUser = function(email, group, callback) {
	if (!callback instanceof Function) callback = new Function;
	verify(function(err) {
		if (err) return callback(err);
		
		log.debug('adding '+email+' to '+group);	
		var options = setOptions('POST', 'https://apps-apis.google.com/a/feeds/group/2.0/'+encodeURIComponent(gaDomain)+'/'+group+'/member');
		var req = https.request(options, function(res) {
			var data = '';
			res.on('data', function(chunk) {
				//log.trace('chunk: '+chunk);
				data += chunk;
			});
			
			res.on('end', function(err) {
				if (err) return callback(err);
				log.trace('addUser api call closed');
				parseError(res.statusCode, data, function(err){ // respond to GData API error
					if (err) return callback(err);
					
					var parser = new xml2js.Parser({mergeAttrs: true});
					parser.parseString(data, function(err, result) {
						if (err) return callback(err);
						
						callback(null, result);
					});
				});
			});
		});
		req.on('error', function(err) {
			log.error('GA addUser failure: '+err.message);
			return callback(err);
		});
		
		req.write('<?xml version="1.0" encoding="UTF-8"?>'
		+'<atom:entry xmlns:atom="http://www.w3.org/2005/Atom" xmlns:apps="http://schemas.google.com/apps/2006" xmlns:gd="http://schemas.google.com/g/2005">'
		+'<apps:property name="memberId" value="'+email+'"/></atom:entry>');
		req.end();
	});
};

/*
	Removes email address from group, only returning data in an error
*/
exports.removeUser = function(email, group, callback) {
	if (!callback instanceof Function) callback = new Function;
	verify(function(err) {
		if (err) return callback(err);
		
		log.debug('removing '+email+' from '+group);
		var options = setOptions('DELETE', 'https://apps-apis.google.com/a/feeds/group/2.0/'+encodeURIComponent(gaDomain)+'/'+group+'/member/'+email);
		var req = https.request(options, function(res) {
			var data = ''; // should not return any data, this is only to catch errors
			res.on('data', function(chunk) {
				//log.trace('chunk: '+chunk);
				data += chunk;
			});
			
			res.on('end', function(err) {
				if (err) return callback(err);
				log.trace('removeUser api call closed');
				parseError(res.statusCode, data, function(err){ // respond to GData API error
					if (err) return callback(err);
					else return callback();
				});
				
			});
			
		});
		req.on('error', function(err) {
			log.error('GA removeUser Failure: '+err.message);
			return callback(err);
		});
		req.end(); // terminate request; finish sending
	});
};

// TESTING


/*
exports.getAllGroups(function(e, result){
	if (e) return log.error("thrown error:\n  "+e.message);
	log.info('all the groups: ');
	result.forEach(function(item) {
		log.info("\n  "+item.name+"\n    ID: "+item.id+"\n    Description: "+item.description);
	});
});/

exports.getGroupsByEmail('elliott', function(err, result){
	log.debug('callback called');
	if (err) return log.error("thrown error:\n  "+err.message);
	log.debug(JSON.stringify(result));
	result.forEach(function(item) {
	 	log.info("\n  "+item.name+"\n    ID: "+item.id+"\n    Description: "+item.description);
	});
});

exports.addUser('elliott', 'test-group', function(err, result){
	log.debug('callback');
	if (err) return log.error("thrown error:\n  "+err.message);
	log.debug(JSON.stringify(result));
});

setTimeout(function(){
exports.removeUser('elliott', 'test-group', function(err) {
	if (err) return log.error("thrown error:\n  "+err.message);
	log.debug('returned, no error');
});
}, 5000);
*/
