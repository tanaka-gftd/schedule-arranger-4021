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
  await Schedule.create({
    scheduleId: scheduleId,
    scheduleName: req.body.scheduleName.slice(0, 255) || '（名称未設定）',
    memo: req.body.memo,
    createdBy: req.user.id,
    updatedAt: updatedAt
  });
  createCandidatesAndRedirect(parseCandidateNames(req), scheduleId, res);
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

router.post('/:scheduleId', authenticationEnsurer, async(req, res, next) => {
  
  //予定IDをもとに、予定データをデータベースから取得
  let schedule = await Schedule.findOne({
    where: {
      scheduleId: req.params.scheduleId
    }
  });

  if(schedule && isMine(req, schedule)) {  //リクエストの送信者が作成者であるかをチェック
    if(parseInt(req.query.edit) === 1) {  //URLのクエリにedit=1がある時のみ更新（更新は予定名、メモ、作成者、更新日時）
      
      const updatedAt = new Date();  //日付を取得

      //予定データを更新（updateはSQLのUPDATE文に対応）
      schedule = await schedule.update({
        scheduleId: schedule.scheduleId,
        scheduleName: req.body.scheduleName.slice(0, 255) || '(名称未設定)',
        memo: req.body.memo,
        createdBy: req.user.id,
        updatedAt: updatedAt
      });

      //リクエストから候補日程の配列をパースする関数をparseCandidateNamesを呼び出す
      const candidateNames = parseCandidateNames(req);

      //追加の候補日程があるかどうかによって処理を切り分ける
      /* 
        追加候補があるかどうかによって 
        ●createCandidatesAndRedirect関数を呼んで、 候補を追加してリダイレクトする
        ●何もせずにそのままリダイレクトする
        となるように、if文で分岐 
      */
      if (candidateNames) {
        createCandidatesAndRedirect(candidateNames, schedule.scheduleId, res);
      } else {
        res.redirect('/schedules/' + schedule.scheduleId);
      }
    } else {

      //edit=1 以外のクエリが渡された際は400BadRequestを返す
      const err = new Error('不正なリクエストです');
      err.status = 400;
      next(err);
    }
  } else {

    //予定が見つからない場合や、自分自身の予定ではない場合は、 404NotFoundを返す
    const err = new Error('指定された予定がない、または、編集する権限がありません');
    err.status = 404;
    next(err);
  }
});


//候補日程の配列、予定ID、レスポンスオブジェクトを受け取り、候補の作成とリダイレクトを行う関数
async function createCandidatesAndRedirect(candidateNames, scheduleId, res) {
  const candidates = candidateNames.map((c) => {
    return {
      candidateName: c,
      scheduleId: scheduleId
    };
  });
  await Candidate.bulkCreate(candidates)  //bulkCreate...SequelizeにおけるBulkInsert（複数のデータを一気に挿入する）のこと
  res.redirect('/schedules/' + scheduleId);
}

//予定名の配列をパースする関数
function parseCandidateNames(req) {
  return req.body.candidates.trim().split('\n').map((s) => s.trim()).filter((s) => s !=="");
}

module.exports = router;
