// Default category tree. Users can rename/add freely; this is just a starting point.
export const DEFAULT_CATEGORIES: Record<string, string[]> = {
  Income: ["Paycheck", "Interest", "Refunds", "Other Income"],
  Housing: ["Rent / Mortgage", "Utilities", "Internet & Phone", "Home Maintenance", "Insurance"],
  Food: ["Groceries", "Restaurants", "Coffee", "Delivery"],
  Transportation: ["Gas", "Parking & Tolls", "Rideshare", "Public Transit", "Auto Maintenance", "Auto Insurance"],
  Shopping: ["General", "Clothing", "Electronics", "Household"],
  Health: ["Medical", "Pharmacy", "Fitness"],
  Entertainment: ["Streaming & Subscriptions", "Events", "Hobbies"],
  Travel: ["Flights", "Lodging", "Travel Other"],
  "Personal & Family": ["Childcare", "Education", "Gifts", "Personal Care", "Pets"],
  Financial: ["Fees", "Taxes", "Charity"],
  Transfers: ["Credit Card Payment", "Internal Transfer", "Savings / Investing"],
};
