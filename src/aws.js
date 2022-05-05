const AWS = require('aws-sdk');
const core = require('@actions/core');
const config = require('./config');

async function startEc2Instance(label, githubRegistrationToken) {
  const ec2 = new AWS.EC2();
  const userData = [];
  userData.push('#!/bin/bash');
  // User data scripts are run as the root user.
  // Docker and git are necessary for GitHub runner and should be pre-installed on the AMI.
  if (config.input.updateRunner) {
    userData.push('mkdir -p /actions-runner && cd /actions-runner && rm -f .runner');
    userData.push('apt-get -y update && apt-get install -y jq');
    userData.push('case $(uname -m) in aarch64) ARCH="arm64" ;; amd64|x86_64) ARCH="x64" ;; esac && export RUNNER_ARCH=${ARCH}');
    userData.push('export RUNNER_VERSION=$(curl -s -X GET \'https://api.github.com/repos/actions/runner/releases/latest\' | jq -r \'.tag_name\' | sed s/v//)');
    userData.push('curl -O -L https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-${RUNNER_ARCH}-${RUNNER_VERSION}.tar.gz');
    userData.push('tar xzf ./actions-runner-linux-${RUNNER_ARCH}-${RUNNER_VERSION}.tar.gz');
    userData.push('export RUNNER_ALLOW_RUNASROOT=1');
    userData.push(`./config.sh --url https://github.com/${config.githubContext.owner} --token ${githubRegistrationToken} --labels ${label}`);
    userData.push('./run.sh');
  } else {
    userData.push('cd /actions-runner && rm -f .runner');
    userData.push('export RUNNER_ALLOW_RUNASROOT=1');
    userData.push(`./config.sh --url https://github.com/${config.githubContext.owner} --token ${githubRegistrationToken} --labels ${label}`);
    userData.push('./run.sh');
  }

  const params = {
    ImageId: config.input.ec2ImageId,
    InstanceType: config.input.ec2InstanceType,
    MinCount: 1,
    MaxCount: 1,
    UserData: Buffer.from(userData.join('\n')).toString('base64'),
    // SubnetId: config.input.subnetId,
    // SecurityGroupIds: [config.input.securityGroupId],
    IamInstanceProfile: { Name: config.input.iamRoleName },
    TagSpecifications: config.tagSpecifications,
    NetworkInterfaces: [{
      DeleteOnTermination: true,
      Description: 'STRING_VALUE',
      DeviceIndex: 0,
      Groups:[config.input.securityGroupId],
      // SubnetId: config.input.subnetId,
      AssociatePublicIpAddress: true
    }]
  };

  if (config.input.withSubnet) {
    params.NetworkInterfaces[0].SubnetId = config.input.subnetId;
    // params.NetworkInterfaces[0].Groups = [config.input.securityGroupId];
  }

  console.log('params', JSON.stringify(params,undefined, 2));
  console.log('input', JSON.stringify(config.input,undefined, 2));

  try {
    const result = await ec2.runInstances(params).promise();
    const ec2InstanceId = result.Instances[0].InstanceId;
    core.info(`AWS EC2 instance ${ec2InstanceId} is started`);
    return ec2InstanceId;
  } catch (error) {
    core.error('AWS EC2 instance starting error');
    throw error;
  }
}

async function terminateEc2Instance() {
  const ec2 = new AWS.EC2();

  const params = {
    InstanceIds: [config.input.ec2InstanceId],
  };

  try {
    await ec2.terminateInstances(params).promise();
    core.info(`AWS EC2 instance ${config.input.ec2InstanceId} is terminated!!`);
    return;
  } catch (error) {
    core.error(`AWS EC2 instance ${config.input.ec2InstanceId} termination error!!`);
    throw error;
  }
}

async function waitForInstanceRunning(ec2InstanceId) {
  const ec2 = new AWS.EC2();

  const params = {
    InstanceIds: [ec2InstanceId],
  };

  try {
    await ec2.waitFor('instanceRunning', params).promise();
    core.info(`AWS EC2 instance ${ec2InstanceId} is up and running!!`);
    return;
  } catch (error) {
    core.error(`AWS EC2 instance ${ec2InstanceId} initialization error`);
    throw error;
  }
}

module.exports = {
  startEc2Instance,
  terminateEc2Instance,
  waitForInstanceRunning,
};
