const axios = require('axios');
const express = require('express');
const tokens = require('./tokens');
const DbClient = require('./db-client');
const provider = require('./src/providers/amazon');

let db = new DbClient(tokens.db);

let pollInterval = 5 * 60 * 1000;
let requestTimeoutId;
const app = express();

function sendMessage(chatId, text) {
	return axios.post(`https://api.telegram.org/bot${ tokens.botToken }/sendMessage`, {
		chat_id: chatId,
		text: text
	});
}

const PubSub = {
	subscribers: {
		update: {}
	},
	subscribe: function(event, id, f) {
		this.subscribers[event][id] = f;
	},
	unsubscribe: function(event, id) {
		delete this.subscribers[event][id];
	},
	isSubscribed: function(event, id) {
		return this.subscribers[event][id];
	},
	trigger: function(event, data) {
		for (let f of Object.values(this.subscribers[event])) {
			f(data);
		}
	}
};

async function requestUpdate() {
	if (Object.values(PubSub.subscribers.update).length === 0) {
		console.log('No subscribers registered. Halting the polling process.');
		return;
	}

	console.log('Requesting the update');
	clearTimeout(requestTimeoutId);
	const urls = [];
	try {
		const data = await provider.getData(urls);
		PubSub.trigger('update', data);
	} catch (error) {
		console.log(error);
	} finally {
		requestTimeoutId = setTimeout(requestUpdate, pollInterval);
	}
}

/**
 * Add a new item to observe.
 * It can be an available date in a hotel
 * or a product on Amazon
 */
async function addItem(chatId, date) {
	await db.updateOrCreateDate(chatId, date);

	console.log('Date', date, 'added for chat id', chatId);
	if (!PubSub.isSubscribed('update', chatId)) {
		console.log('Chat id', chatId, 'has subscribed for data updates');
		PubSub.subscribe('update', chatId, async function(data) {
			const dates = await db.getUserDates(chatId);

			const invalidDates = [];
			const availableDates = [];
			console.log('Checking data for chat id:', chatId, 'dates: ', dates.join(', '));
			dates.forEach(date => {
				if (data[date] === undefined) {
					invalidDates.push(date);
					removeItem(chatId, date);
				} else if (data[date] > 0) {
					availableDates.push(date);
					//removeItem(chatId, date);
				}
			});
			if (invalidDates.length) {
				sendMessage(chatId, 'Unable to poll for date ' + invalidDates.join(', ') + ' as it\'s out of range');
			}
			if (availableDates.length) {
				sendMessage(chatId, 'Places found for date ' + availableDates.join(', ') + '.\n\n' +
					'You can book them here: http://refugedugouter.ffcam.fr/resapublic.html.');
				console.log('Sending success message for chat id:', chatId, 'date:', availableDates.join(', '));
			}
		});
	}
}

/**
 * Stop observing the item
 */
async function removeItem(chatId, date) {
	await db.removeDate(chatId, date);
	const dates = await db.getUserDates(chatId);
	if (dates.length === 0) {
		PubSub.unsubscribe('update', chatId);
		console.log('Chat id', chatId, 'has unsubscribed from data updates');
	}
}

function handleStartPolling(chatId, date) {
	addItem(chatId, date);
	requestUpdate();
	return sendMessage(chatId, 'Starting polling availability for date ' + date);
}

async function handleStopPolling(chatId, date) {
	let message;
	const dates = await db.getUserDates(chatId);
	if (dates.includes(date)) {
		message = 'Polling cancelled for date ' + date;
		removeItem(chatId, date);
	} else {
		message = 'There were no polling processes for date ' + date;
	}
	return sendMessage(chatId, message);
}

async function handleClearCommand(chatId) {
	const dates = await db.getUserDates(chatId);
	let message;
	if (dates.length) {
		message = 'Polling processes for dates ' + dates.sort().join(', ') + ' are stopped';
		db.clearDates(chatId);
	} else {
		message = 'No processes to stop';
	}
	return sendMessage(chatId, message);
}

async function checkStatus(chatId) {
	const dates = await db.getUserDates(chatId);
	let message;
	if (dates.length) {
		message = 'Polling processes are run for dates ' + dates.sort().join(', ');
	} else {
		message = 'No processes running';
	}
	return sendMessage(chatId, message);
}

app.use(express.json());

app.get('/', (req, res) => {
	res.status(200).send('Hello, my bot!');
});

app.post('/bot/' + tokens.webhookToken, (req, res) => {
	const message = req.body.message || req.body.edited_message;
	if (!message) {
		console.log(JSON.stringify(req.body));
		res.send({ status: 'OK' });
		return;
	}
	const chatId = message.chat.id;
	let handlerPromise;
	if (message.text === '/start') {
		handlerPromise = sendMessage(chatId, 'Hi. I\'m here to help you find available places in Refuge du Goûter.\n\n' +
		'I can understand the following commands:\n' +
		'	/status: List current polling processes.\n' +
		'	poll [date]: Init polling for a date in format YYYY-MM-DD, e.g. poll 2018-07-10.\n' +
		'	stop [date]: Stop polling for a date in format YYYY-MM-DD, e.g. stop 2018-07-10.\n' +
		'	/clear: Stop all polling processes.');
	} else if (message.text === '/status') {
		handlerPromise = checkStatus(chatId);
	} else if (message.text === '/clear') {
		handlerPromise = handleClearCommand(chatId);
	} else if (message.text.match(/^\/?poll/i)) {
		const date = message.text.match(/20\d\d-\d\d-\d\d/);
		if (date) {
			handlerPromise = handleStartPolling(chatId, date[0]);
		} else {
			handlerPromise = sendMessage(chatId, 'Couldn\'t parse the date. ' +
				'Please enter the date in format YYYY-MM-DD, e.g. "poll 2018-07-10".');
		}
	} else if (message.text.match(/^\/?stop/i)) {
		const date = message.text.match(/20\d\d-\d\d-\d\d/);
		if (date) {
			handlerPromise = handleStopPolling(chatId, date[0]);
		} else {
			handlerPromise = sendMessage(chatId, 'Couldn\'t parse the date. ' +
				'Please enter the date in format YYYY-MM-DD, e.g. "stop 2018-07-10".');
		}
	} else {
		console.log(message.text);
		handlerPromise = sendMessage(chatId, 'I can understand the following commands:\n' +
		'	/status: List current polling processes.\n' +
		'	poll [date]: Init polling for a date in format YYYY-MM-DD, e.g. poll 2018-07-10.\n' +
		'	stop [date]: Stop polling for a date in format YYYY-MM-DD, e.g. stop 2018-07-10.\n' +
		'	/clear: Stop all polling processes.');
	}
    
	handlerPromise
		.then(function () {
			res.send({ status: 'OK' });
		})
		.catch(function (error) {
			console.log(error);
			res.sendStatus(500);
		});
});

if (module === require.main) {
	const server = app.listen(process.env.PORT || 8080, () => {
		const port = server.address().port;
		console.log(`App listening on port ${port}`);
	});
}

module.exports = app;