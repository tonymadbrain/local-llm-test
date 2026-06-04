# Contributing to Our Project

Thank you for your interest in contributing! We welcome community involvement, whether you are fixing bugs, improving documentation, or proposing new features.

Because this project is licensed under the **AGPLv3** and requires commercial flexibility, please read this guide carefully before writing or submitting any code.

---

## 📜 Important: Contributor License Agreement (CLA)

To protect the project and ensure we can maintain long-term agility, **all contributors must agree to our Contributor License Agreement (CLA)**.

* You can read the full agreement in the [CLA.md](./CLA.md) file.
* **How to sign:** When you open a Pull Request, a template will automatically load. You must check the CLA acceptance box and provide your name/username in the PR description.
* **We cannot merge any code without this signature.** If you are forbidden by your employer from signing a CLA, please contact us before writing code.

---

## 🚀 How to Get Started

### 1. Development Setup
This project uses **mise** for tool management and **uv** for Python environments and dependencies.

1. Ensure you have [mise](https://jdx.dev) installed on your machine.
2. Fork and clone the repository.
3. Trust the local configuration and let `mise` automatically download the correct Python and `uv` versions:
   ```bash
   mise trust
   ```
4. Initialize the environment and install all dependencies (including dev tools) into a locked virtual environment:
   ```bash
   mise run setup
   ```
5. Before committing code, ensure everything is clean and passing rules by running:
   ```bash
   mise run lint
   ```

### 2. Code Style & Standards
To keep the codebase clean and maintainable, please follow these guidelines:
* **Python Standards:** Code must strictly adhere to modern Python standards and support the version specified in `pyproject.toml`.
* **Formatting:** We use standard formatting tools. Run your linter/formatter (e.g., `black`, `ruff`, or `flake8` depending on your setup) before committing.
* **License Headers:** Every new `.py` file **must** include the standard AGPLv3 copyright header block at the very top.

---

## 📥 Submitting Changes

1. **Create a Branch:** Create a descriptively named feature branch (`git checkout -b feature/my-new-feature`).
2. **Write Tests:** Ensure your changes are covered by tests and that all existing tests pass.
3. **Commit Messages:** Write clear, concise commit messages.
4. **Push and Open a PR:** Push your branch to your fork and open a Pull Request against our `main` branch.
5. **Fill Out the Template:** Complete the Pull Request template entirely, making sure to **check the CLA agreement box**.

---

## 🙋‍♂️ Need Help?

If you have questions about the codebase, features, or the CLA, please open a GitHub Issue or reach out to the project maintainers.
