# GitHub Blueprint

Blueprint for GitHub repos.

## Usage

```bash
$ rsync -aP .github /path/to/repo/
```

## Repo Configuration

* Default branch should be `master`
* If relevant, `production` is used as the production branc h
* Branch protection should be enabled on master and production with:
  * `Require a pull request before merging`, `Require approvals` and `Require review from Code Owners`
  * `Require status checks to pass before merging`

## Code Owner

Adjust `.github/CODEOWNERS` to the squad that owns the repo.