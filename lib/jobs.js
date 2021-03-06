var async = require('async'),
    moment = require('moment'),
    events = require('events'),
    _ = require('lodash'),
    shouldStillProcess,
    pg = require('pg'),
    Transaction = require('pg-transaction'),
    debug = require('debug')('pg-jobs');

/**
 * @param Object options Options hash containing:
 *  - db (mandatory DB URI)
 *  - pollInterval pollInterval - How often to poll for new jobs when idle (ms).
 */
module.exports = function(options) {
  var Jobs = {};
  var jobsModel = require('../models/jobs');

  // Expose jobs model when we are testing so we can set up stuff on the Db.
  if (process.env.NODE_ENV === 'test') {
    Jobs.jobsModel = jobsModel;
  }

  Jobs.eventEmitter = new events.EventEmitter();

  /**
   * @param {Object} job The data you want to save for the job.  This is
   *   freeform and up to you.
   * @param {int} processIn The job will not get service until this many ms have
       elapsed. Set to null if you do not want to service it again.
   * @param {function} done Callback.
   */
  Jobs.create = function(jobData, processIn, done) {
    pg.connect(options.db, connected);

    function connected(err, db, cb) {
      if (err) return complete(err);

      jobsModel.write(db, null, processIn, jobData, complete);

      function complete(err, jobId) {
        cb(); // Return the client to the pool
        done(err, jobId);
      }
    }
  };

  function updateJob(db, jobSnapshot, newJobData, processIn, cb) {
    if (processIn === undefined) processIn = null;

    jobsModel.write(db, jobSnapshot.job_id, processIn, newJobData, complete);

    function complete(err) {
      if (err) return cb(err);
      Jobs.eventEmitter.emit('jobUpdated');
      cb();
    }
  }

  function serviceJob(db, jobContainer, userJobIterator, callback) {
    return userJobIterator(jobContainer.job_id, jobContainer.data,
        processingComplete);

    function processingComplete(err, newJobData, processIn) {
      if (err) {
        return callback(err);
      } else {
        jobsModel.setProcessedNow(db, jobContainer.job_id);
        updateJob(db, jobContainer, newJobData, processIn, callback);
      }
    }
  }

  Jobs.stopProcessing = function() {
    shouldStillProcess = false;
  };

  Jobs.continueProcessing = function() {
    return shouldStillProcess;
  };

  /**
   * Examines and services jobs in the 'jobs' array, repeatedly, forever, unless
   * stopProcessing() is called.
   * Call this once to start processing jobs.
   * @param {function} serviceJob Iterator function to be run on jobs requiring
   *                   service.
   * @param {function} done callback to receive errors pertaining to running
   * process() - i.e. db connection issues. Also called when stopProcessing() is
   * called.
   */
  Jobs.process = function(processFunction, done) {
    shouldStillProcess = true;
    done = done || function() {};
    pg.connect(options.db, connected);

    function connected(err, db, releaseClient) {
      if (err) return done(err);
      async.whilst(Jobs.continueProcessing, iterator, finish);

      function iterator(callback) {
        setImmediate(function() {
          Jobs.eventEmitter.emit('maybeServiceJob');
          debug('Getting next job to process...');
          jobsModel.nextToProcess(db, getJobProcessor(false, db, processFunction, callback));
        });
      }
      function finish(err) {
        releaseClient();
        Jobs.eventEmitter.emit('stopProcess');
        done();
      }
    }
  };

  Jobs.processNow = function(jobId, processFunction, done) {
    done = done || function() {};
    pg.connect(options.db, connected);

    function connected(err, db, releaseClient) {
      if (err) return done(err);

      debug('seeking lock for', jobId);
      jobsModel.obtainLock(db, jobId, gotLock);

      function gotLock(err) {
        debug('obtained lock for', jobId);
        if (err) return done(err);
        jobsModel.getDataForJob(db, jobId, gotData);
      }

      var gotData = getJobProcessor(true, db, processFunction, processed);

      function processed(err) {
        jobsModel.unlock(db, jobId);
        releaseClient();
        debug('client released', err);
        done(err);
      }
    }
  };

  /* Return a function that will be given the job to process it.
   * @param {function} processFunction The user's worker.
   * @param {function} User callback.
   */
  function getJobProcessor(now, db, processFunction, callback) {
    return function(err, jobSnap) {
      if (err) return callback(err);
      if (!jobSnap) {
        if (now) return callback(new Error('Could not locate job'));

        Jobs.eventEmitter.emit('drain');
        debug('No job found, sleeping...');
        return setTimeout(callback, options.pollInterval || 1000);
      }
      debug('Processing job...');
      processJob(jobSnap);
    };

    function processJob(jobSnap) {
      var tx = new Transaction(db);
      tx.begin();
      serviceJob(tx, jobSnap, processFunction, function(err) {
        if (err) {
          debug('Job serviced with error.');
          tx.rollback(txDone);
        } else {
          debug('Job serviced without error.');
          tx.commit(txDone);
        }
        function txDone() {
          Jobs.eventEmitter.emit(now ? 'processNowCommitted' : 'processCommitted');
          callback(err);
        }
      });
    }
  }

  return Jobs;
};

// vim: set et sw=2 ts=2 colorcolumn=80:
