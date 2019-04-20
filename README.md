# Generate Terraform AWS VPC

Generate Terraform AWS VPC is a Node utility script to automatically generate Terraform scripts for AWS that create a VPC, subnets for defined network tiers
and security group and network ACLs from defined traffic rules between the network tiers. 

## Installation

1. Clone this repository using Git.

2. Use NPM to install the dependencies required for this script. 

    ```bash
    npm install
    ```

## Usage

1. Define your network tiers and network traffic rules in the `config.yaml` file.

2. Run the following command to generate the Terraform scripts in the `output` directory.
```bash
node index.js
```

## AWS VPC Limits
Do note that AWS VPC imposes limits on the number of security groups and network ACLs, as well as the number of inbound and outbound rules in each security group or network ACL.
The generated resources may exceed these limits, so modify your configuration accordingly. 

## License
[MIT](https://choosealicense.com/licenses/mit/)