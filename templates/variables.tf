variable "vpc_cidr_block" {
  type = "string"
}

variable "vpc_name" {
  type = "string"
}


variable "vpc_owner" {
  type = "string"
}

variable "remote_management_cidrs" {
  type = "list"
  default = []
}


variable "remote_https_cidrs" {
  type = "list"
  default = []
}
