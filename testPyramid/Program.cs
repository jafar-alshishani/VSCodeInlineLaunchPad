// Sample program for manually testing the C# Inline Launch Pad (F5 -> Alt+F5).
Console.WriteLine($"args: [{string.Join(", ", args)}]");
Console.Write("Height? ");
var height = int.TryParse(Console.ReadLine(), out var h) ? h : 3;

for (var row = 1; row <= height; row++)
{
    Console.WriteLine(new string(' ', height - row) + new string('*', 2 * row - 1));



// Display a welcome message to the user
Console.WriteLine("=== Welcome to the C# Console App ===");

// Prompt the user for input


// Perform a calculation and display the result


// Keep the console window open until a key is pressed
Console.WriteLine("\nPress any key to exit...");
Console.ReadKey();
}
