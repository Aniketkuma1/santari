const github = require('octonode');
const osTmpdir = require('os-tmpdir')();
const semver = require('semver');
const path = require('path');
const uuid = require('../libs/uuid');
const packageLib = require('./package');
const ncu = require('npm-check-updates');
const deepEqual = require('deep-equal');
const logger = require('../libs/logger');

const accessKey = process.env.GITHUB_KEY;

if (!accessKey) {
  logger.error('Github access token environment variable does not exist! Please create one at GITHUB_KEY');
  process.exit(0);
}

const client = github.client(accessKey);

module.exports = class Santari {
  constructor(repoName) {
    this.repoDetails = client.repo(repoName);
    this.masterSHA = ''; // master SHA
    this.packageSHA = ''; // package JSON SHA
    this.packagePath = ''; // package path from repo
    this.packageJSON = ''; // JSON parsed version of repo package
    this.packageTempPath = ''; // package path where temp package is stored. To be used by ncu
    this.depBranchName = `update-deps-santari-${Math.ceil(Math.random() * 100000)}`;
    this.mainBranch = 'master';
    this.prOpts = {
      title: 'Updating Dependencies',
      body: 'Dependencies to Update',
      head: this.depBranchName,
      base: this.mainBranch
    };
  }

  checkAlreadyExists() {
    return new Promise((resolve, reject) => {
      this.repoDetails.branches((err, branches) => {
        if (err) {
          return reject(err);
        }
        if (branches.filter(f => f.name.includes('update-deps-santari')).length > 0) {
          return reject('PR/Branch is already created and active!');
        }
        resolve(true);
      });
    });
  }

  getBranchDetails(branchName = 'master') {
    return new Promise((resolve, reject) => {
      this.repoDetails.branch(branchName, (err, result) => {
        if (err) {
          return reject(err);
        }

        this.mainBranch = branchName;
        this.masterSHA = result.commit.sha;
        resolve(result);
      });
    });
  }

  getPackageDetails() {
    return new Promise((resolve, reject) => {
      this.repoDetails.contents('package.json', (err, result) => {
        if (err) {
          return reject(err);
        }
        this.packageSHA = result.sha;
        this.packagePath = result.path;
        this.packageJSON = JSON.parse(Buffer.from(result.content, 'base64').toString());
        this.writePackageToTemp(result.content);
        resolve(result);
      });
    });
  }

  writePackageToTemp(content) {
    const tempId = uuid();
    const packagePath = path.join(osTmpdir, `package_${tempId}.json`);
    packageLib.writePackageJson(content, packagePath);
    this.packageTempPath = packagePath;
  }

  checkForUpdates() {
    return new Promise((resolve, reject) => {
      ncu.run({
        packageFile: this.packageTempPath,
        silent: true,
        jsonUpgraded: true,
        jsonAll: true
      })
        .then((newPackageJSON) => {
          if (deepEqual(newPackageJSON, this.packageJSON)) {
            return resolve(null); // nothing to update
          }
          resolve(newPackageJSON);
        })
        .catch((e) => {
          reject(e);
        });
    });
  }

  createBranch() {
    return new Promise((resolve, reject) => {
      if (!this.masterSHA) {
        return reject('SHA is invalid.');
      }
      this.repoDetails.createReference(this.depBranchName, this.masterSHA, (err, result) => {
        if (err) {
          return reject(err);
        }
        resolve(result);
      });
    });
  }

  updatePackageFile(commitMessage, content) {
    return new Promise((resolve, reject) => {
      if (!this.packageSHA || !this.packagePath) {
        return reject('Package SHA/Path is invalid');
      }

      // update the minor version
      content.version = semver.inc(content.version, 'minor'); // eslint-disable-line

      this.repoDetails.updateContents(this.packagePath,
        commitMessage,
        JSON.stringify(content, null, 2),
        this.packageSHA,
        this.depBranchName, (err, result) => {
          if (err) {
            return reject(err);
          }

          return resolve(result);
        });
    });
  }

  createPR() {
    return new Promise((resolve, reject) => {
      this.repoDetails.pr(this.prOpts, (err, result) => {
        if (err) {
          return reject(err);
        }
        return resolve(result);
      });
    });
  }
};