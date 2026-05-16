// src/mockData.js

// Helper to randomly distribute inventory states for testing
const getRandomStatus = () => {
  const rand = Math.random();
  if (rand < 0.3) return { status: "empty", sku: null, qty: 0, lastMovedDays: 0 };
  if (rand < 0.7) return { status: "current_stock", sku: `SKU-${Math.floor(Math.random() * 900 + 100)}`, qty: Math.floor(Math.random() * 80 + 20), lastMovedDays: Math.floor(Math.random() * 10) };
  if (rand < 0.85) return { status: "low_stock", sku: `SKU-${Math.floor(Math.random() * 900 + 100)}`, qty: Math.floor(Math.random() * 5 + 1), lastMovedDays: Math.floor(Math.random() * 5) };
  return { status: "slow_moving", sku: `SKU-${Math.floor(Math.random() * 900 + 100)}`, qty: Math.floor(Math.random() * 100 + 10), lastMovedDays: Math.floor(Math.random() * 60 + 30) };
};

export const generateWarehouseLayout = (config) => {
  const slots = [];
  const { totalAisles, baysPerAisle, levelsPerRack, aisleSpacing, baySpacing, levelHeight } = config;

  for (let a = 0; a < totalAisles; a++) {
    // Each aisle has a Left Row (0) and a Right Row (1) facing the center driving lane
    for (let row = 0; row < 2; row++) {
      // Calculate X coordinate: Aisle gap + structural offset for left/right rows
      const xPos = a * aisleSpacing + (row === 0 ? -0.8 : 0.8);

      for (let b = 0; b < baysPerAisle; b++) {
        const zPos = b * baySpacing;

        for (let l = 0; l < levelsPerRack; l++) {
          const yPos = l * levelHeight + (levelHeight / 2); // Center of the shelf box
          const inventory = getRandomStatus();

          slots.push({
            id: `Aisle-${a}-Row-${row}-Bay-${b}-Lvl-${l}`,
            position: [xPos, yPos, zPos],
            aisle: a,
            row: row,
            bay: b,
            level: l,
            ...inventory
          });
        }
      }
    }
  }
  return slots;
};

export const COLOR_MAP = {
  empty: "#475569",         // Slate Gray (representing empty structural steel)
  current_stock: "#10b981", // Emerald Green
  low_stock: "#f59e0b",     // Amber Yellow
  slow_moving: "#ef4444",   // Red
};
