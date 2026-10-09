# Dependencies

Package manifests and lockfiles: adding, upgrading or removing a library.

### DEP-01 Needed at all
- **Ask:** Does the purpose need this dependency, or does the standard library or an existing dependency already do it?
- **Right way:** Prefer what is already in the tree; every new dependency is code you now maintain.
- **Proof:** One line in the PR naming why existing options did not fit.

### DEP-02 Lockfile committed
- **Ask:** Is the exact resolved version recorded, so every environment installs the same thing?
- **Right way:** Commit the lockfile with the manifest change; install from it in CI and deploys.
- **Proof:** Lockfile in the diff; CI installs with the frozen-lockfile option.

### DEP-03 Breaking changes
- **Ask:** Does the upgrade cross a major version, or change behavior the code relies on?
- **Right way:** Read the changelog between the old and new versions; run the tests that cover its call sites.
- **Proof:** Changelog entries reviewed; call-site tests pass.

### DEP-04 Known vulnerabilities and trust
- **Ask:** Does the version have known vulnerabilities, and is the package what it claims to be (maintained, not a look-alike name)?
- **Right way:** Run the ecosystem's audit tool; check the package name, publisher and recent maintenance before adding (S9).
- **Proof:** Audit output for the changed packages.

### DEP-05 Size and runtime cost
- **Ask:** Does it add significant install size, bundle size for users, or startup time?
- **Right way:** Check the added size for client bundles; import only what is used.
- **Proof:** Bundle or install size before and after.

### DEP-06 License
- **Ask:** Is the license compatible with how the product is distributed?
- **Right way:** Check the license of the package and anything new it pulls in.
- **Proof:** License named in the PR.
