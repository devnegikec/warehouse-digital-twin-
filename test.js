async function printUnicode(docUrl) {
  try {
    // Read the file and get the data
    const response = await fetch(docUrl);
    const data = await response.text();

    // Parse the data
    const lines = data.split(/\r?\n/);
    const grid = {};
    let maxX = 0;
    let maxY = 0;

    for (const line of lines) {
      const parts = line.split(',');
      if (parts.length === 3) {
        const char = parts[0].trim();
        const x = parseInt(parts[1].trim(), 10);
        const y = parseInt(parts[2].trim(), 10);

        // Skip rows where coordinates aren't valid numbers (like headers)
        if (isNaN(x) || isNaN(y)) continue;

        grid[`${x},${y}`] = char;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }

    // Construct the grid (Array of arrays filled with spaces)
    const outputGrid = Array.from({ length: maxY + 1 }, () =>
      Array(maxX + 1).fill(' ')
    );

    // Fill the grid with characters
    for (const key in grid) {
      const [x, y] = key.split(',').map(Number);
      outputGrid[y][x] = grid[key];
    }

    // Print the grid
    for (const row of outputGrid) {
      console.log(row.join(''));
    }
  } catch (error) {
    console.error("Error fetching or processing the grid:", error);
  }
}


var url = 'https://raw.githubusercontent.com/teodorescu/teodorescu.github.io/main/unicode-grid.txt';
// console.log("Fetching and printing the Unicode grid from:", url);
console.log(printUnicode(url));
