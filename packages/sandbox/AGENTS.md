Do not use .unwrap (except in tests).
Make sure to run clippy and fix all lint errors.
Before finishing, make sure to run tests and `docker build`. The user will be running ./scripts/cmux.sh, and we want to make sure it starts as fast as possible (so we need to prime the docker cache).
After finishing, use the macOS `say` command to notify the user with a short description of what to check.
