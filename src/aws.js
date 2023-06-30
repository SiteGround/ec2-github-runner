// const EC2 = require('@aws-sdk/client-ec2');
const core = require('@actions/core');
const { EC2, waitUntilInstanceRunning, EC2Client } = require('@aws-sdk/client-ec2');
const config = require('./config');

async function startEc2Instance(label, githubRegistrationToken) {
  const ec2 = new EC2({apiVersion: '2016-11-15'});
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
  }

  try {
    core.startGroup("Starting the EC2 Instance");
    const result = await ec2.runInstances(params);
    const ec2InstanceId = result.Instances[0].InstanceId;
    core.info(`AWS EC2 instance ${ec2InstanceId} is started`);
    core.endGroup();
    if (config.input.elasticIp) {
      core.startGroup("Assigning elastic IP to instance");
      core.info("Searching for a free (unassigned) elastic IP...");
      const elasticIpPool = config.input.elasticIp.trim().split(',').map(function(element) {
        return element.trim();
      });

      const data = await ec2.describeAddresses({ AllocationIds: elasticIpPool });

      const freeEip = data.Addresses.find(function(address) {
        return !address.InstanceId;
      });

      if (freeEip === undefined) {
        throw new Error(`No free IP among ids: ${elasticIpPool} found`);
      }

      core.info(`Elastic IP ${freeEip.AllocationId}:${freeEip.PublicIp} found without current association!`);

      const ipParams = {
        AllocationId: freeEip.AllocationId,
        InstanceId: ec2InstanceId
      };

      // Retry mechanism
      let retries = 10;
      let result = null;
      while(retries > 0) {
        try {
          result = await ec2.associateAddress(ipParams);
          core.info("Associated IP address with instance: " + result.AssociationId);
          break;
        } catch (err) {
          core.info("Could not associate IP address, retrying: " + err.toString());
          retries--;
          await new Promise(resolve => setTimeout(resolve, 3000)); // wait for 3 seconds before retrying
        }
      }
      if (retries === 0) {
        throw new Error(`Failed to associate IP after several attempts.`);
      }
    }

    return ec2InstanceId;
  } catch (error) {
    core.error('AWS EC2 instance starting error');
    core.endGroup();
    throw error;
  }
}

async function terminateEc2Instance() {
  const ec2 = new EC2({apiVersion: '2016-11-15'});

  const params = {
    InstanceIds: [config.input.ec2InstanceId],
  };

  try {
    core.startGroup("Stopping the EC2 Instance");
    await ec2.terminateInstances(params);
    core.info(`AWS EC2 instance ${config.input.ec2InstanceId} is terminated!!`);
    core.endGroup();
  } catch (error) {
    core.error(`AWS EC2 instance ${config.input.ec2InstanceId} termination error!!`);
    core.endGroup();
    throw error;
  }
}

async function waitForInstanceRunning(ec2InstanceId) {
  const ec2 = new EC2Client({apiVersion: '2016-11-15'});
  const params = {
    InstanceIds: [ ec2InstanceId ],
  };

  try {
    core.startGroup("Waiting for instance to become ready");

    console.log(params);
    await waitUntilInstanceRunning({ec2, maxWaitTime: 240},  params);

    core.info(`AWS EC2 instance ${ec2InstanceId} is up and running!!`);
    core.endGroup();
  } catch (error) {
    core.error(`AWS EC2 instance ${ec2InstanceId} initialization error`);
    core.endGroup();
    throw error;
  }
}

module.exports = {
  startEc2Instance,
  terminateEc2Instance,
  waitForInstanceRunning,
};
