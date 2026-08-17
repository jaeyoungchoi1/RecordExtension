const available = document.getElementById("available");
const radios = Array.from(document.querySelectorAll('input[name="distance"]'));
const form = document.getElementById("searchForm");
const filterStatus = document.getElementById("filterStatus");
const routeStatus = document.getElementById("routeStatus");
const dialog = document.getElementById("detailsDialog");
const selectButton = document.getElementById("selectButton");

function renderFilters() {
  const distance = radios.find((radio) => radio.checked)?.value || "any distance";
  filterStatus.textContent = `${available.checked ? "Available" : "All"}; ${distance}`;
}

available.addEventListener("change", renderFilters);
radios.forEach((radio) => radio.addEventListener("change", renderFilters));
form.addEventListener("submit", (event) => {
  event.preventDefault();
  filterStatus.textContent = `Query applied: ${new FormData(form).get("query")}`;
});
document.getElementById("spaButton").addEventListener("click", () => {
  history.pushState({ route: "results" }, "", "?view=results");
  routeStatus.textContent = "Route: results";
});
document.getElementById("modalButton").addEventListener("click", () => dialog.showModal());
document.getElementById("closeModal").addEventListener("click", () => dialog.close());
selectButton.addEventListener("click", () => {
  const selected = selectButton.getAttribute("aria-pressed") !== "true";
  selectButton.setAttribute("aria-pressed", String(selected));
  selectButton.textContent = selected ? "Candidate A selected" : "Select candidate A";
});
window.addEventListener("popstate", () => {
  routeStatus.textContent = location.search ? "Route: results" : "Route: home";
});
