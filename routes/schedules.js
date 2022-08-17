'use strict';
const express = require('express');
const router = express.Router();
const authenticationEnsurer = require('./authentication-ensurer');
const { v4: uuidv4 } = require('uuid');
const Schedule = require('../models/schedule');
const Candidate = require('../models/candidate');
const User = require('../models/user');
const Availability = require('../models/availability');
const Comment = require('../models/comment');

router.get('/new', authenticationEnsurer, (req, res, next) => {
  res.render('new', { user: req.user });
});

router.post('/', authenticationEnsurer, async (req, res, next) => {
  const scheduleId = uuidv4();
  const updatedAt = new Date();
  const schedule = await Schedule.create({
    scheduleId: scheduleId,
    scheduleName: req.body.scheduleName.slice(0, 255) || '（名称未設定）',
    memo: req.body.memo,
    createdBy: req.user.id,
    updatedAt: updatedAt
  });
  const candidateNames = req.body.candidates.trim().split('\n').map((s) => s.trim()).filter((s) => s !== "");
  const candidates = candidateNames.map((c) => { return {
    candidateName: c,
    scheduleId: schedule.scheduleId
  };});
  await Candidate.bulkCreate(candidates);
  res.redirect('/schedules/' + schedule.scheduleId);
});

router.get('/:scheduleId', authenticationEnsurer, async (req, res, next) => {
  const schedule = await Schedule.findOne({
    include: [
      {
        model: User,
        attributes: ['userId', 'username']
      }],
    where: {
      scheduleId: req.params.scheduleId
    },
    order: [['updatedAt', 'DESC']]
  });
  if (schedule) {
    const candidates = await Candidate.findAll({
      where: { scheduleId: schedule.scheduleId },
      order: [['candidateId', 'ASC']]
    });
    // データベースからその予定の全ての出欠を取得する
    const availabilities = await Availability.findAll({
      include: [
        {
          model: User,
          attributes: ['userId', 'username']
        }
      ],
      where: { scheduleId: schedule.scheduleId },
      order: [[User, 'username', 'ASC'], ['candidateId', 'ASC']]
    });
    // 出欠 MapMap(キー:ユーザー ID, 値:出欠Map(キー:候補 ID, 値:出欠)) を作成する
    const availabilityMapMap = new Map(); // key: userId, value: Map(key: candidateId, value: availability)
    availabilities.forEach((a) => {
      const map = availabilityMapMap.get(a.user.userId) || new Map();
      map.set(a.candidateId, a.availability);
      availabilityMapMap.set(a.user.userId, map);
    });

    // 閲覧ユーザーと出欠に紐づくユーザーからユーザー Map (キー:ユーザー ID, 値:ユーザー) を作る
    const userMap = new Map(); // key: userId, value: User
    userMap.set(parseInt(req.user.id), {
        isSelf: true,
        userId: parseInt(req.user.id),
        username: req.user.username
    });
    availabilities.forEach((a) => {
      userMap.set(a.user.userId, {
        isSelf: parseInt(req.user.id) === a.user.userId, // 閲覧ユーザー自身であるかを含める
        userId: a.user.userId,
        username: a.user.username
      });
    });

    // 全ユーザー、全候補で二重ループしてそれぞれの出欠の値がない場合には、「欠席」を設定する
    const users = Array.from(userMap).map((keyValue) => keyValue[1]);
    users.forEach((u) => {
      candidates.forEach((c) => {
        const map = availabilityMapMap.get(u.userId) || new Map();
        const a = map.get(c.candidateId) || 0; // デフォルト値は 0 を利用
        map.set(c.candidateId, a);
        availabilityMapMap.set(u.userId, map);
      });
    });

    // コメント取得
    const comments = await Comment.findAll({
      where: { scheduleId: schedule.scheduleId }
    });
    const commentMap = new Map();  // key: userId, value: comment
    comments.forEach((comment) => {
      commentMap.set(comment.userId, comment.comment);
    });
    res.render('schedule', {
      user: req.user,
      schedule: schedule,
      candidates: candidates,
      users: users,
      availabilityMapMap: availabilityMapMap,
      commentMap: commentMap
    });
  } else {
    const err = new Error('指定された予定は見つかりません');
    err.status = 404;
    next(err);
  }
});

router.get('/:scheduleId/edit', authenticationEnsurer, async(req, res, next) => {  //予定編集URLを指定

  //URLパラメータで指定された予定IDを、データベースから抽出
  const schedule = await Schedule.findOne({
    where: {
      scheduleId: req.params.scheduleId
    }
  });

  //isMine という関数を別途用意して、自身の予定であるかどうかを判定
  if (isMine(req, schedule)) {  

    //予定候補日をデータベースから抽出＆昇順に並び替え
    const candidates = await Candidate.findAll({
      where: { scheduleId: schedule.scheduleId },
      order: [['candidateId', 'ASC']]
    });

    //テンプレートedit.pugを描画
    res.render('edit', {
      user: req.user,
      schedule: schedule,
      candidates: candidates
    });
  } else {

    //指定された予定が、自分が作成したものでなかったり、そもそも存在しない時は、404エラーを返す
    const err = new Error('指定された予定がない、または、予定する権限がありません');
    err.status = 404;
    next(err);
  }
});

//リクエストと予定オブジェクトを受け取り、その予定が自分自身のものかを判定し、真偽値を返す
function isMine(req, schedule) {
  return schedule && parseInt(schedule.createdBy) === parseInt(req.user.id);
}

module.exports = router;
