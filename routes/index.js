'use strict';
const express = require('express');
const router = express.Router();
const Schedule = require('../models/schedule');

/* GET home page. */
router.get('/', async (req, res, next) => {
  const title = '予定調整くん';
  if (req.user) {
    const schedules = await Schedule.findAll({
      where: {
        createdBy: req.user.id
      },
      order: [['updatedAt', 'DESC']]
    });
    res.render('index', {
      title: title,
      user: req.user,
      schedules: schedules
    });
  } else {
    res.render('index', { title: title, user: req.user });
  }
});

module.exports = router;
