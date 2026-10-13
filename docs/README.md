# GitHub Desktop Documentation

This is the [GitHub Desktop (fork)](https://github.com/Jairik/git-desktop)
development documentation.

## Contributing

If you are interested in contributing to the project, you should read these
resources to get familiar with how things work:

 - **[Development Environment Setup](contributing/setup.md)** - everything
    you need to know to get Desktop up and running
 - **[Engineering Values](contributing/engineering-values.md)** - our high-level engineering values
 - **[Style Guide](contributing/styleguide.md)** - notes on the coding style
 - **[Tooling](contributing/tooling.md)** - if you have a preferred IDE,
    there's some enhancements to make your life easier
 - **[Troubleshooting](contributing/troubleshooting.md)** - some additional
    known issues if you're having environment issues

## Technical

These documents contain more details about the internals of GitHub Desktop
and how things work:

 - **[Dialogs](technical/dialogs.md)** - details about the dialog component API
 - **[Windows menu bar](technical/windows-menu-bar.md)** - Electron doesn't
    provide inbuilt support for styling the menu for Windows, so we've created
    our own custom components to achieve this.
 - **[Developer OAuth App](technical/oauth.md)** - GitHub Desktop ships with
    the ability to OAuth on behalf of a user. A developer OAuth app is bundled
    to reduce the friction of getting started.
 - **[Building and Packaging Desktop](technical/packaging.md)** - Outlines how
    Desktop is currently packaged for all platforms 
 - **[Automatic Git Proxy support](technical/proxies.md)** - A pre-launch overview
    and troubleshooting guide for the Git automatic proxy support in GitHub Desktop.
