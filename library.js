'use strict';

const topics = require.main.require('./src/topics');
const posts = require.main.require('./src/posts');
const categories = require.main.require('./src/categories');
const meta = require.main.require('./src/meta');
const privileges = require.main.require('./src/privileges');
const rewards = require.main.require('./src/rewards');
const user = require.main.require('./src/user');
const helpers = require.main.require('./src/controllers/helpers');
const db = require.main.require('./src/database');
const plugins = require.main.require('./src/plugins');
const SocketPlugins = require.main.require('./src/socket.io/plugins');
const pagination = require.main.require('./src/pagination');

const plugin = module.exports;

plugin.init = async function (params) {
	const app = params.router;
	const { middleware } = params;

	app.get('/admin/plugins/question-and-answer', middleware.admin.buildHeader, renderAdmin);
	app.get('/api/admin/plugins/question-and-answer', renderAdmin);

	app.get('/unsolved', middleware.applyCSRF, middleware.buildHeader, renderUnsolved);
	app.get('/api/unsolved', renderUnsolved);

	app.get('/solved', middleware.applyCSRF, middleware.buildHeader, renderSolved);
	app.get('/api/solved', renderSolved);

	handleSocketIO();

	plugin._settings = await meta.settings.get('question-and-answer');
};

plugin.appendConfig = async function (config) {
	config['question-and-answer'] = plugin._settings;
	return config;
};

plugin.addNavigation = async function (menu) {
	menu = menu.concat(
		[
			{
				route: '/unsolved',
				title: '[[qanda:menu.unsolved]]',
				iconClass: 'fa-question-circle',
				textClass: 'visible-xs-inline',
				text: '[[qanda:menu.unsolved]]',
			},
			{
				route: '/solved',
				title: '[[qanda:menu.solved]]',
				iconClass: 'fa-check-circle',
				textClass: 'visible-xs-inline',
				text: '[[qanda:menu.solved]]',
			},
		]
	);
	return menu;
};

plugin.addAdminNavigation = async function (header) {
	header.plugins.push({
		route: '/plugins/question-and-answer',
		icon: 'fa-question-circle',
		name: 'Q&A',
	});
	return header;
};

plugin.addAnswerDataToTopic = async function (hookData) {
	if (!parseInt(hookData.templateData.isQuestion, 10)) {
		return hookData;
	}

	hookData.templateData.icons.push(
		parseInt(hookData.templateData.isSolved, 10) ?
			'<span class="answered"><i class="fa fa-check"></i>[[qanda:topic_solved]]</span>' :
			'<span class="unanswered"><i class="fa fa-question-circle"></i> [[qanda:topic_unsolved]]</span>');

	const solvedPid = parseInt(hookData.templateData.solvedPid, 10);
	if (!solvedPid || hookData.templateData.pagination.currentPage > 1) {
		return await addMetaData(hookData);
	}

	const answers = await posts.getPostsByPids([solvedPid], hookData.uid);
	const postsData = await topics.addPostData(answers, hookData.uid);
	let post = postsData[0];
	if (post) {
		const bestAnswerTopicData = { ...hookData.templateData };
		bestAnswerTopicData.posts = postsData;

		const topicPrivileges = await privileges.topics.get(hookData.templateData.tid, hookData.req.uid);
		await topics.modifyPostsByPrivilege(bestAnswerTopicData, topicPrivileges);

		post = bestAnswerTopicData.posts[0];
		post.index = -1;

		const op = hookData.templateData.posts.shift();
		hookData.templateData.posts.unshift(post);
		hookData.templateData.posts.unshift(op);
	}

	// Also expose an `isAnswer` boolean in the post object itself
	hookData.templateData.posts.forEach((post) => {
		post.isAnswer = post.pid === solvedPid;
	});

	return await addMetaData(hookData);
};

async function addMetaData(data) {
	const { tid } = data.templateData;
	const { uid } = data.req;
	const pidsToFetch = [data.templateData.mainPid, await posts.getPidsFromSet(`tid:${tid}:posts:votes`, 0, 0, true)];
	let mainPost, suggestedAnswer, acceptedAnswer;

	if (data.templateData.solvedPid) {
		pidsToFetch.push(data.templateData.solvedPid);
	}

	const postsData = [mainPost, suggestedAnswer, acceptedAnswer] = await posts.getPostsByPids(pidsToFetch, uid);
	await topics.addPostData(postsData, uid);

	postsData.forEach((p) => {
		p.content = String(p.content || '')
			.replace(/\\/g, '\\\\')
			.replace(/\n/g, '\\n')
			.replace(/"/g, '\\"')
			.replace(/\t/g, '\\t');
	});

	data.templateData.mainPost = mainPost ? mainPost : {};
	data.templateData.acceptedAnswer = acceptedAnswer ? acceptedAnswer : {};
	if (suggestedAnswer && suggestedAnswer.pid !== data.templateData.mainPid) {
		data.templateData.suggestedAnswer = suggestedAnswer ? suggestedAnswer : {};
	}

	data.res.locals.postHeader = await data.req.app.renderAsync('partials/question-and-answer/topic-jsonld', data.templateData);
	return data;
}

plugin.getTopics = async function (hookData) {
	hookData.topics.forEach((topic) => {
		if (topic && parseInt(topic.isQuestion, 10)) {
			if (parseInt(topic.isSolved, 10)) {
				topic.icons.push('<span class="answered"><i class="fa fa-check"></i> [[qanda:topic_solved]]</span>');
			} else {
				topic.icons.push('<span class="unanswered"><i class="fa fa-question-circle"></i> [[qanda:topic_unsolved]]</span>');
			}
		}
	});
	return hookData;
};

plugin.addThreadTool = async function (hookData) {
	const isSolved = parseInt(hookData.topic.isSolved, 10);

	if (parseInt(hookData.topic.isQuestion, 10)) {
		hookData.tools = hookData.tools.concat([
			{
				class: `toggleSolved ${isSolved ? 'alert-warning topic-solved' : 'alert-success topic-unsolved'}`,
				title: isSolved ? '[[qanda:thread.tool.mark_unsolved]]' : '[[qanda:thread.tool.mark_solved]]',
				icon: isSolved ? 'fa-question-circle' : 'fa-check-circle',
			},
			{
				class: 'toggleQuestionStatus',
				title: '[[qanda:thread.tool.make_normal]]',
				icon: 'fa-comments',
			},
		]);
	} else {
		hookData.tools.push({
			class: 'toggleQuestionStatus alert-warning',
			title: '[[qanda:thread.tool.as_question]]',
			icon: 'fa-question-circle',
		});
	}
	return hookData;
};

plugin.addPostTool = async function (hookData) {
	const data = await topics.getTopicDataByPid(hookData.pid);
	if (!data) {
		return hookData;
	}

	data.isSolved = parseInt(data.isSolved, 10) === 1;
	data.isQuestion = parseInt(data.isQuestion, 10) === 1;
	const canEdit = await privileges.topics.canEdit(data.tid, hookData.uid);
	if (canEdit && !data.isSolved && data.isQuestion && parseInt(data.mainPid, 10) !== parseInt(hookData.pid, 10)) {
		hookData.tools.push({
			action: 'qanda/post-solved',
			html: '[[qanda:post.tool.mark_correct]]',
			icon: 'fa-check-circle',
		});
	}
	return hookData;
};

plugin.getConditions = async function (conditions) {
	conditions.push({
		name: 'Times questions accepted',
		condition: 'qanda/question.accepted',
	});
	return conditions;
};

plugin.onTopicCreate = async function (payload) {
	let isQuestion;
	if (payload.data.hasOwnProperty('isQuestion')) {
		isQuestion = true;
	}

	// Overrides from ACP config
	if (plugin._settings.forceQuestions === 'on' || plugin._settings[`defaultCid_${payload.topic.cid}`] === 'on') {
		isQuestion = true;
	}

	if (!isQuestion) {
		return payload;
	}

	await topics.setTopicFields(payload.topic.tid, { isQuestion: 1, isSolved: 0 });
	await db.sortedSetAdd('topics:unsolved', Date.now(), payload.topic.tid);
	return payload;
};

plugin.actionTopicSave = async function (hookData) {
	if (hookData.topic && hookData.topic.isQuestion) {
		await db.sortedSetAdd(hookData.topic.isSolved === 1 ? 'topics:solved' : 'topics:unsolved', Date.now(), hookData.topic.tid);
	}
};

plugin.filterTopicEdit = async function (hookData) {
	const isNowQuestion = hookData.data.isQuestion === true || parseInt(hookData.data.isQuestion, 10) === 1;
	const wasQuestion = parseInt(await topics.getTopicField(hookData.topic.tid, 'isQuestion'), 10) === 1;
	if (isNowQuestion !== wasQuestion) {
		await toggleQuestionStatus(hookData.req.uid, hookData.topic.tid);
	}

	return hookData;
};

plugin.actionTopicPurge = async function (hookData) {
	if (hookData.topic) {
		await db.sortedSetsRemove(['topics:solved', 'topics:unsolved'], hookData.topic.tid);
	}
};

plugin.filterComposerPush = async function (hookData) {
	const tid = await posts.getPostField(hookData.pid, 'tid');
	const isQuestion = await topics.getTopicField(tid, 'isQuestion');
	hookData.isQuestion = isQuestion;

	return hookData;
};

plugin.staticApiRoutes = async function ({ router, middleware, helpers }) {
	router.get('/qna/:tid', middleware.assert.topic, async (req, res) => {
		let { isQuestion, isSolved } = await topics.getTopicFields(req.params.tid, ['isQuestion', 'isSolved']);
		isQuestion = isQuestion || '0';
		isSolved = isSolved || '0';
		helpers.formatApiResponse(200, res, { isQuestion, isSolved });
	});
};

plugin.registerTopicEvents = async function ({ types }) {
	types = {
		...types,
		'qanda.as_question': {
			icon: 'fa-question',
			text: '[[qanda:thread.alert.as_question]]',
		},
		'qanda.make_normal': {
			type: 'qanda.make_normal',
			text: '[[qanda:thread.alert.make_normal]]',
		},
		'qanda.solved': {
			icon: 'fa-check',
			text: '[[qanda:thread.alert.solved]]',
		},
		'qanda.unsolved': {
			icon: 'fa-question',
			text: '[[qanda:thread.alert.unsolved]]',
		},
	};

	return { types };
};

async function renderAdmin(req, res) {
	const cids = await db.getSortedSetRange('categories:cid', 0, -1);
	const data = await categories.getCategoriesFields(cids, ['cid', 'name', 'parentCid']);
	res.render('admin/plugins/question-and-answer', {
		categories: categories.getTree(data),
	});
}

function handleSocketIO() {
	SocketPlugins.QandA = {};

	SocketPlugins.QandA.toggleSolved = async function (socket, data) {
		const canEdit = await privileges.topics.canEdit(data.tid, socket.uid);
		if (!canEdit) {
			throw new Error('[[error:no-privileges]]');
		}

		return await toggleSolved(socket.uid, data.tid, data.pid);
	};

	SocketPlugins.QandA.toggleQuestionStatus = async function (socket, data) {
		const canEdit = await privileges.topics.canEdit(data.tid, socket.uid);
		if (!canEdit) {
			throw new Error('[[error:no-privileges]]');
		}

		return await toggleQuestionStatus(socket.uid, data.tid);
	};
}

async function toggleSolved(uid, tid, pid) {
	let isSolved = await topics.getTopicField(tid, 'isSolved');
	isSolved = parseInt(isSolved, 10) === 1;

	const updatedTopicFields = isSolved ?
		{ isSolved: 0, solvedPid: 0 } :
		{ isSolved: 1, solvedPid: pid };

	if (plugin._settings.toggleLock === 'on') {
		updatedTopicFields.locked = isSolved ? 0 : 1;
	}

	await topics.setTopicFields(tid, updatedTopicFields);

	if (isSolved) {
		await Promise.all([
			db.sortedSetAdd('topics:unsolved', Date.now(), tid),
			db.sortedSetRemove('topics:solved', tid),
			topics.events.log(tid, { type: 'qanda.unsolved', uid }),
		]);
	} else {
		await Promise.all([
			db.sortedSetRemove('topics:unsolved', tid),
			db.sortedSetAdd('topics:solved', Date.now(), tid),
			topics.events.log(tid, { type: 'qanda.solved', uid }),
		]);

		if (pid) {
			const data = await posts.getPostData(pid);
			await rewards.checkConditionAndRewardUser({
				uid: data.uid,
				condition: 'qanda/question.accepted',
				method: async function () {
					await user.incrementUserFieldBy(data.uid, 'qanda/question.accepted', 1);
				},
			});
		}
	}

	plugins.hooks.fire('action:topic.toggleSolved', { uid: uid, tid: tid, pid: pid, isSolved: !isSolved });
	return { isSolved: !isSolved };
}

async function toggleQuestionStatus(uid, tid) {
	let isQuestion = await topics.getTopicField(tid, 'isQuestion');
	isQuestion = parseInt(isQuestion, 10) === 1;

	if (!isQuestion) {
		await Promise.all([
			topics.setTopicFields(tid, { isQuestion: 1, isSolved: 0, solvedPid: 0 }),
			db.sortedSetAdd('topics:unsolved', Date.now(), tid),
			db.sortedSetRemove('topics:solved', tid),
			topics.events.log(tid, { type: 'qanda.as_question', uid }),
		]);
	} else {
		await Promise.all([
			topics.deleteTopicFields(tid, ['isQuestion', 'isSolved', 'solvedPid']),
			db.sortedSetsRemove(['topics:solved', 'topics:unsolved'], tid),
			topics.events.log(tid, { type: 'qanda.make_normal', uid }),
		]);
	}

	plugins.hooks.fire('action:topic.toggleQuestion', { uid: uid, tid: tid, isQuestion: !isQuestion });
	return { isQuestion: !isQuestion };
}

async function canPostTopic(uid) {
	let cids = await categories.getAllCidsFromSet('categories:cid');
	cids = await privileges.categories.filterCids('topics:create', cids, uid);
	return cids.length > 0;
}

async function renderUnsolved(req, res) {
	await renderQnAPage('unsolved', req, res);
}

async function renderSolved(req, res) {
	await renderQnAPage('solved', req, res);
}

async function renderQnAPage(type, req, res) {
	const page = parseInt(req.query.page, 10) || 1;
	const { cid } = req.query;
	const [settings, categoryData, canPost, isPrivileged] = await Promise.all([
		user.getSettings(req.uid),
		helpers.getSelectedCategory(cid),
		canPostTopic(req.uid),
		user.isPrivileged(req.uid),
	]);

	const topicsData = await getTopics(type, page, cid, req.uid, settings);

	const data = {};
	data.topics = topicsData.topics;
	data.showSelect = isPrivileged;
	data.showTopicTools = isPrivileged;
	data.allCategoriesUrl = type + helpers.buildQueryString(req.query, 'cid', '');
	data.selectedCategory = categoryData.selectedCategory;
	data.selectedCids = categoryData.selectedCids;

	data['feeds:disableRSS'] = true;
	const pageCount = Math.max(1, Math.ceil(topicsData.topicCount / settings.topicsPerPage));
	data.pagination = pagination.create(page, pageCount);
	data.canPost = canPost;
	data.title = `[[qanda:menu.${type}]]`;

	if (req.path.startsWith(`/api/${type}`) || req.path.startsWith(`/${type}`)) {
		data.breadcrumbs = helpers.buildBreadcrumbs([{ text: `[[qanda:menu.${type}]]` }]);
	}

	res.render('recent', data);
}

async function getTopics(type, page, cids, uid, settings) {
	cids = cids || [];
	if (!Array.isArray(cids)) {
		cids = [cids];
	}
	const set = `topics:${type}`;
	let tids = [];
	if (cids.length) {
		cids = await privileges.categories.filterCids('read', cids, uid);
		const allTids = await Promise.all(cids.map(async (cid) => {
			return await db.getSortedSetRevIntersect({
				sets: [set, `cid:${cid}:tids:lastposttime`],
				start: 0,
				stop: 199,
			});
		}));
		tids = allTids.flat().sort((tid1, tid2) => tid2 - tid1);
	} else {
		tids = await db.getSortedSetRevRange(set, 0, 199);
		tids = await privileges.topics.filterTids('read', tids, uid);
	}

	const start = Math.max(0, (page - 1) * settings.topicsPerPage);
	const stop = start + settings.topicsPerPage - 1;

	const topicCount = tids.length;

	tids = tids.slice(start, stop + 1);

	const topicsData = await topics.getTopicsByTids(tids, uid);
	topics.calculateTopicIndices(topicsData, start);
	return {
		topicCount,
		topics: topicsData,
	};
}